import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { configureIagOrchestratorToolService } from '../apps/mcp-server/src/iag-orchestrator-tools.js';
import { consumeIagMutationNonce } from '../packages/sangfor-operator/src/index.js';
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
const domainResultSchema = z.object({
  outcome: z.enum(['SUCCEEDED', 'REFUSED']), reasonCode: z.string().optional(),
}).passthrough();
const callSchema = z.object({
  result: z.object({ structuredContent: z.unknown().optional(), isError: z.boolean() }).passthrough(),
}).passthrough();
type McpModule = typeof import('../apps/mcp-server/src/index.js');
let mcp: McpModule;
let root = '';

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'iag-mcp-replay-'));
  configureIagOrchestratorTestEnvironment(root);
  process.env.SANGFOR_IAG_ORCHESTRATOR_LEDGER_SECRET = IAG_ORCHESTRATOR_LEDGER_SECRET;
  process.env.SANGFOR_IAG_ORCHESTRATOR_CHECKPOINT_SECRET = IAG_ORCHESTRATOR_CHECKPOINT_SECRET;
  mcp = await import('../apps/mcp-server/src/index.js');
});

afterEach(() => {
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

async function apply(argumentsValue: Record<string, unknown>) {
  const response = await mcp.handle({
    jsonrpc: '2.0', id: 16, method: 'tools/call',
    params: { name: 'sangfor_iag_exception_apply', arguments: argumentsValue },
  });
  return callSchema.parse(response).result;
}

async function successfulFixture() {
  const refs = await configureIagMcpFixture({ root, dryRun: false, authorityKind: 'ordinary_active' });
  const first = await apply({
    actionPath: refs.actionPath, configPath: refs.configPath,
    approvalEnvelopePath: refs.approvalEnvelopePath,
  });
  expect(domainResultSchema.parse(first.structuredContent).outcome).toBe('SUCCEEDED');
  return refs;
}

function args(refs: Awaited<ReturnType<typeof successfulFixture>>) {
  return {
    actionPath: refs.actionPath, configPath: refs.configPath,
    approvalEnvelopePath: refs.approvalEnvelopePath,
  };
}

describe('IAG terminal apply replay over MCP', () => {
  it('Given prior success and a deleted approval file, When exact apply replays, Then MCP errors without extra work', async () => {
    const refs = await successfulFixture();
    unlinkSync(refs.approvalEnvelopePath);

    const replay = await apply(args(refs));

    expect(replay.isError).toBe(true);
    expect(refs.fixture.adapterFixture.dispatches).toHaveLength(1);
    expect(refs.fixture.adapterFixture.readBacks).toHaveLength(1);
  });

  it('Given prior success and an empty domain approval, When exact apply replays, Then MCP typed-refuses', async () => {
    const refs = await successfulFixture();
    writeApprovalEnvelope(refs.approvalEnvelopePath, {});

    const replay = domainResultSchema.parse((await apply(args(refs))).structuredContent);

    expect(replay).toMatchObject({ outcome: 'REFUSED', reasonCode: 'APPROVAL_FIELDS_REQUIRED' });
    expect(refs.fixture.adapterFixture.dispatches).toHaveLength(1);
  });

  it('Given prior success and the consumed approval, When exact apply replays, Then MCP reports APPROVAL_REPLAY', async () => {
    const refs = await successfulFixture();

    const replay = domainResultSchema.parse((await apply(args(refs))).structuredContent);

    expect(replay).toMatchObject({ outcome: 'REFUSED', reasonCode: 'APPROVAL_REPLAY' });
    expect(refs.fixture.adapterFixture.dispatches).toHaveLength(1);
  });

  it('Given prior success and fresh valid approval, When exact apply replays, Then status is required and nonce stays fresh', async () => {
    const refs = await successfulFixture();
    const fresh = mintTerminalReplayApproval(refs.fixture, 'mcp-fresh-terminal');
    writeApprovalEnvelope(refs.approvalEnvelopePath, fresh);

    const replay = domainResultSchema.parse((await apply(args(refs))).structuredContent);

    expect(replay).toMatchObject({ outcome: 'REFUSED', reasonCode: 'RUN_ALREADY_TERMINAL_USE_STATUS' });
    await expect(consumeIagMutationNonce(fresh, IAG_ORCHESTRATOR_NOW)).resolves.toEqual({ ok: true });
    expect(refs.fixture.adapterFixture.dispatches).toHaveLength(1);
  });

  it('Given prior success and a changed digest, When old approval is applied, Then binding refuses before conflict truth', async () => {
    const refs = await successfulFixture();
    writeFileSync(refs.actionPath, changedTerminalReplaySource(refs.fixture));

    const replay = domainResultSchema.parse((await apply(args(refs))).structuredContent);

    expect(replay).toMatchObject({ outcome: 'REFUSED', reasonCode: 'APPROVAL_SIGNATURE_REFUSED' });
    expect(refs.fixture.adapterFixture.dispatches).toHaveLength(1);
  });

  it('Given prior success and a changed digest with fresh binding, When apply conflicts, Then MCP refuses and nonce stays fresh', async () => {
    const refs = await successfulFixture();
    const source = changedTerminalReplaySource(refs.fixture);
    const fresh = await mintChangedTerminalReplayApproval(refs.fixture, source, 'mcp-fresh-conflict');
    writeFileSync(refs.actionPath, source);
    writeApprovalEnvelope(refs.approvalEnvelopePath, fresh);

    const replay = domainResultSchema.parse((await apply(args(refs))).structuredContent);

    expect(replay).toMatchObject({ outcome: 'REFUSED', reasonCode: 'IDEMPOTENCY_CONFLICT' });
    await expect(consumeIagMutationNonce(fresh, IAG_ORCHESTRATOR_NOW)).resolves.toEqual({ ok: true });
    expect(refs.fixture.adapterFixture.dispatches).toHaveLength(1);
  });

  it('Given prior success and a corrupt terminal store, When apply replays, Then MCP errors without leaking terminal success', async () => {
    const refs = await successfulFixture();
    writeFileSync(refs.fixture.ledgerPath, '{corrupt-terminal');

    const replay = await apply(args(refs));

    expect(replay.isError).toBe(true);
    expect(refs.fixture.adapterFixture.dispatches).toHaveLength(1);
    expect(refs.fixture.adapterFixture.readBacks).toHaveLength(1);
  });

  it('Given prior success, When consumed approval replays concurrently, Then every MCP result refuses without extra work', async () => {
    const refs = await successfulFixture();

    const results = await Promise.all([apply(args(refs)), apply(args(refs))]);

    expect(results.map((result) => domainResultSchema.parse(result.structuredContent).reasonCode))
      .toEqual(['APPROVAL_REPLAY', 'APPROVAL_REPLAY']);
    expect(refs.fixture.adapterFixture.dispatches).toHaveLength(1);
    expect(refs.fixture.adapterFixture.readBacks).toHaveLength(1);
  });
});
