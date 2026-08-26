import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createBridgeServer, type McpRequestFn } from '../apps/http-bridge/src/server.js';
import { configureIagOrchestratorToolService } from '../apps/mcp-server/src/iag-orchestrator-tools.js';
import { consumeIagMutationNonce } from '../packages/sangfor-operator/src/index.js';
import { signApprovalToken } from '../packages/sangfor-operator/src/approval.js';
import { cleanupTestIagMutationAuthorityEnvironment } from './helpers/iag-mutation-contract-fixture.js';
import { configureIagMcpFixture } from './helpers/iag-mcp-tool-fixture.js';
import {
  IAG_ORCHESTRATOR_CHECKPOINT_SECRET,
  IAG_ORCHESTRATOR_LEDGER_SECRET,
  IAG_ORCHESTRATOR_NOW,
  configureIagOrchestratorTestEnvironment,
} from './helpers/iag-orchestrator-fixture.js';
import {
  changedTerminalReplaySource,
  mintChangedTerminalReplayApproval,
  mintTerminalReplayApproval,
  writeApprovalEnvelope,
} from './helpers/iag-terminal-replay-fixture.js';

process.env.MCP_NO_SERVE = '1';
process.env.BRIDGE_NO_SERVE = '1';
const responseSchema = z.object({
  result: z.object({ structuredContent: z.unknown().optional(), isError: z.boolean() }).passthrough(),
}).passthrough();
const domainResultSchema = z.object({
  outcome: z.enum(['SUCCEEDED', 'REFUSED']), reasonCode: z.string().optional(),
}).passthrough();
type McpModule = typeof import('../apps/mcp-server/src/index.js');
type Refs = Awaited<ReturnType<typeof configureIagMcpFixture>>;
let mcp: McpModule;
let root = '';
let server: http.Server;
let baseUrl = '';
let bridgeNonce = 0;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'iag-http-replay-'));
  configureIagOrchestratorTestEnvironment(root);
  process.env.SANGFOR_IAG_ORCHESTRATOR_LEDGER_SECRET = IAG_ORCHESTRATOR_LEDGER_SECRET;
  process.env.SANGFOR_IAG_ORCHESTRATOR_CHECKPOINT_SECRET = IAG_ORCHESTRATOR_CHECKPOINT_SECRET;
  mcp = await import('../apps/mcp-server/src/index.js');
  const mcpRequest: McpRequestFn = async (method, params) => {
    const response = await mcp.handle({ jsonrpc: '2.0', id: 1, method, params });
    if ('error' in response && response.error !== undefined) return { jsonrpc: '2.0', id: 1, error: response.error };
    return { jsonrpc: '2.0', id: 1, result: response.result };
  };
  server = createBridgeServer({ remoteBind: false, mcpRequest });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new TypeError('BRIDGE_ADDRESS_INVALID');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  configureIagOrchestratorToolService(undefined);
  cleanupTestIagMutationAuthorityEnvironment();
  for (const key of [
    'SANGFOR_ALLOW_REAL_EXECUTION', 'SANGFOR_ALLOW_PRODUCTION_EXECUTION',
    'SANGFOR_IAG_BOOTSTRAP_APPROVAL_SECRET', 'SANGFOR_OPERATOR_APPROVAL_SECRET',
    'SANGFOR_NONCE_STORE', 'SANGFOR_NONCE_STORE_PATH',
    'SANGFOR_IAG_ORCHESTRATOR_LEDGER_SECRET', 'SANGFOR_IAG_ORCHESTRATOR_CHECKPOINT_SECRET',
  ]) delete process.env[key];
  rmSync(root, { recursive: true, force: true });
});

function bridgeApproval() {
  const secret = process.env.SANGFOR_OPERATOR_APPROVAL_SECRET;
  if (secret === undefined) throw new TypeError('BRIDGE_SECRET_MISSING');
  const fields = {
    approvedBy: 'bridge-replay', changeTicketId: 'CHG-BRIDGE', rollbackPlanId: 'RB-BRIDGE',
    nonce: `bridge-replay-${bridgeNonce += 1}`, expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  return {
    ...fields,
    approvalToken: signApprovalToken(secret, {
      type: 'bridge.tool-call', target: 'sangfor_iag_exception_apply',
    }, fields),
  };
}

async function httpApply(refs: Refs) {
  const response = await fetch(`${baseUrl}/tools/call`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'sangfor_iag_exception_apply', approval: bridgeApproval(),
      arguments: {
        actionPath: refs.actionPath, configPath: refs.configPath,
        approvalEnvelopePath: refs.approvalEnvelopePath,
      },
    }),
  });
  return { status: response.status, body: responseSchema.parse(await response.json()).result };
}

async function successfulFixture(): Promise<Refs> {
  const refs = await configureIagMcpFixture({ root, dryRun: false, authorityKind: 'ordinary_active' });
  const first = await httpApply(refs);
  expect(first.status).toBe(200);
  expect(domainResultSchema.parse(first.body.structuredContent).outcome).toBe('SUCCEEDED');
  return refs;
}

describe('IAG terminal apply replay over guarded loopback HTTP', () => {
  it('Given HTTP prior success and a deleted approval file, When exact apply replays, Then it errors without extra work', async () => {
    const refs = await successfulFixture();
    unlinkSync(refs.approvalEnvelopePath);

    const replay = await httpApply(refs);

    expect(replay.body.isError).toBe(true);
    expect(refs.fixture.adapterFixture.dispatches).toHaveLength(1);
    expect(refs.fixture.adapterFixture.readBacks).toHaveLength(1);
  });

  it('Given HTTP prior success and an empty approval, When exact apply replays, Then it typed-refuses', async () => {
    const refs = await successfulFixture();
    writeApprovalEnvelope(refs.approvalEnvelopePath, {});

    const replay = domainResultSchema.parse((await httpApply(refs)).body.structuredContent);

    expect(replay).toMatchObject({ outcome: 'REFUSED', reasonCode: 'APPROVAL_FIELDS_REQUIRED' });
    expect(refs.fixture.adapterFixture.dispatches).toHaveLength(1);
  });

  it('Given HTTP prior success and consumed approval, When exact apply replays, Then it reports APPROVAL_REPLAY', async () => {
    const refs = await successfulFixture();

    const replay = domainResultSchema.parse((await httpApply(refs)).body.structuredContent);

    expect(replay).toMatchObject({ outcome: 'REFUSED', reasonCode: 'APPROVAL_REPLAY' });
    expect(refs.fixture.adapterFixture.dispatches).toHaveLength(1);
  });

  it('Given HTTP prior success and fresh approval, When exact apply replays, Then status is required and nonce remains fresh', async () => {
    const refs = await successfulFixture();
    const fresh = mintTerminalReplayApproval(refs.fixture, 'http-fresh-terminal');
    writeApprovalEnvelope(refs.approvalEnvelopePath, fresh);

    const replay = domainResultSchema.parse((await httpApply(refs)).body.structuredContent);

    expect(replay).toMatchObject({ outcome: 'REFUSED', reasonCode: 'RUN_ALREADY_TERMINAL_USE_STATUS' });
    await expect(consumeIagMutationNonce(fresh, IAG_ORCHESTRATOR_NOW)).resolves.toEqual({ ok: true });
    expect(refs.fixture.adapterFixture.dispatches).toHaveLength(1);
  });

  it('Given HTTP prior success and changed digest, When old approval replays, Then binding refuses before conflict truth', async () => {
    const refs = await successfulFixture();
    writeFileSync(refs.actionPath, changedTerminalReplaySource(refs.fixture));

    const replay = domainResultSchema.parse((await httpApply(refs)).body.structuredContent);

    expect(replay).toMatchObject({ outcome: 'REFUSED', reasonCode: 'APPROVAL_SIGNATURE_REFUSED' });
    expect(refs.fixture.adapterFixture.dispatches).toHaveLength(1);
  });

  it('Given HTTP prior success and changed digest with fresh binding, When apply conflicts, Then it refuses and nonce stays fresh', async () => {
    const refs = await successfulFixture();
    const source = changedTerminalReplaySource(refs.fixture);
    const fresh = await mintChangedTerminalReplayApproval(refs.fixture, source, 'http-fresh-conflict');
    writeFileSync(refs.actionPath, source);
    writeApprovalEnvelope(refs.approvalEnvelopePath, fresh);

    const replay = domainResultSchema.parse((await httpApply(refs)).body.structuredContent);

    expect(replay).toMatchObject({ outcome: 'REFUSED', reasonCode: 'IDEMPOTENCY_CONFLICT' });
    await expect(consumeIagMutationNonce(fresh, IAG_ORCHESTRATOR_NOW)).resolves.toEqual({ ok: true });
    expect(refs.fixture.adapterFixture.dispatches).toHaveLength(1);
  });

  it('Given HTTP prior success and corrupt terminal store, When apply replays, Then it errors without terminal leakage', async () => {
    const refs = await successfulFixture();
    writeFileSync(refs.fixture.ledgerPath, '{corrupt-terminal');

    const replay = await httpApply(refs);

    expect(replay.body.isError).toBe(true);
    expect(refs.fixture.adapterFixture.dispatches).toHaveLength(1);
    expect(refs.fixture.adapterFixture.readBacks).toHaveLength(1);
  });

  it('Given HTTP prior success, When consumed approval replays concurrently, Then all results refuse without extra work', async () => {
    const refs = await successfulFixture();

    const results = await Promise.all([httpApply(refs), httpApply(refs)]);

    expect(results.map(({ body }) => domainResultSchema.parse(body.structuredContent).reasonCode))
      .toEqual(['APPROVAL_REPLAY', 'APPROVAL_REPLAY']);
    expect(refs.fixture.adapterFixture.dispatches).toHaveLength(1);
    expect(refs.fixture.adapterFixture.readBacks).toHaveLength(1);
  });
});
