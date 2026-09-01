import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBridgeServer, type McpRequestFn } from '../apps/http-bridge/src/server.js';
import { createBrowserExecutionAuthorityPort } from '../packages/sangfor-browser-contracts/src/index.js';
import { authorizeToolCall } from '../packages/sangfor-operator/src/tool-authorization.js';
import {
  configureIagOrchestratorToolService,
  iagOrchestratorToolCatalog,
} from '../apps/mcp-server/src/iag-orchestrator-tools.js';
import { signApprovalToken } from '../packages/sangfor-operator/src/approval.js';
import { generateProductChangePlan } from '../packages/sangfor-product-adapters/src/index.js';
import { cleanupTestIagMutationAuthorityEnvironment } from './helpers/iag-mutation-contract-fixture.js';
import {
  configureIagOrchestratorTestEnvironment,
  IAG_ORCHESTRATOR_CHECKPOINT_SECRET,
  IAG_ORCHESTRATOR_LEDGER_SECRET,
} from './helpers/iag-orchestrator-fixture.js';
import { configureIagMcpFixture } from './helpers/iag-mcp-tool-fixture.js';

process.env.MCP_NO_SERVE = '1';

type McpModule = typeof import('../apps/mcp-server/src/index.js');
let mcp: McpModule;
let root = '';
let escapedLedgerPath = '';

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'mcp-iag-tools-'));
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
  if (escapedLedgerPath !== '') {
    rmSync(escapedLedgerPath, { force: true });
    rmSync(`${escapedLedgerPath}.checkpoint.json`, { force: true });
    escapedLedgerPath = '';
  }
});

function tool(name: string) {
  const handler = mcp.getToolHandler(name);
  if (handler === undefined) throw new TypeError(`MISSING_TOOL:${name}`);
  return handler;
}

describe('verified IAG MCP and HTTP catalog surface', () => {
  it('Given the live catalog, When IAG tools are listed, Then dry-run/status are read-only and apply is destructive with strict reference-only schemas', async () => {
    const names = ['sangfor_iag_exception_dry_run', 'sangfor_iag_exception_apply', 'sangfor_iag_exception_status'] as const;
    const listed = new Map(mcp.listTools().map((entry) => [entry.name, entry]));

    expect(listed.get(names[0])?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(listed.get(names[1])?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(listed.get(names[2])?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    for (const name of names) {
      const schema = JSON.stringify(listed.get(name)?.inputSchema);
      expect(schema).not.toMatch(/password|secret|cookie|formFields|evidence_bootstrap|purpose/u);
      expect(listed.get(name)?.inputSchema).toMatchObject({ additionalProperties: false });
    }
    expect(mcp.listTools().some(({ name }) => name.includes('evidence_bootstrap'))).toBe(false);
  });

  it('Given the shared live catalog, When the HTTP guard evaluates the tools, Then reads pass and unapproved apply refuses', async () => {
    const toolListResult = { tools: mcp.listTools() };

    await expect(authorizeToolCall({
      name: 'sangfor_iag_exception_dry_run', toolListResult, enforceWhitelist: true,
    })).resolves.toEqual({ allow: true });
    await expect(authorizeToolCall({
      name: 'sangfor_iag_exception_status', toolListResult, enforceWhitelist: true,
    })).resolves.toEqual({ allow: true });
    await expect(authorizeToolCall({
      name: 'sangfor_iag_exception_apply', toolListResult, enforceWhitelist: false,
      remoteBind: true, allowRemoteWrite: false,
    })).resolves.toMatchObject({ allow: false, status: 403 });
  });

  it('Given a genuine dry-run action reference, When called through MCP, Then Todo 15 returns DRY_RUN_COMPLETE without dispatch', async () => {
    const refs = await configureIagMcpFixture({ root, dryRun: true });

    const result = await tool('sangfor_iag_exception_dry_run')({
      actionPath: refs.actionPath, configPath: refs.configPath,
    });

    expect(result).toMatchObject({ outcome: 'DRY_RUN_COMPLETE', mutationAttempted: false, verifiedSuccess: false });
    expect(refs.fixture.adapterFixture.dispatches).toHaveLength(0);
  });

  it('Given an absent caller-selected ledger path, When dry-run executes, Then no ledger, checkpoint, lock, or directory is created', async () => {
    const refs = await configureIagMcpFixture({ root, dryRun: true });
    const config = JSON.parse(readFileSync(refs.configPath, 'utf8')) as {
      orchestrator: { ledgerPath: string };
    };
    const absentRoot = join(root, 'caller-selected', 'nested');
    config.orchestrator.ledgerPath = join(absentRoot, 'orchestrator.jsonl');
    writeFileSync(refs.configPath, JSON.stringify(config));

    const result = await tool('sangfor_iag_exception_dry_run')({
      actionPath: refs.actionPath, configPath: refs.configPath,
    });

    expect(result).toMatchObject({ outcome: 'DRY_RUN_COMPLETE', mutationAttempted: false });
    expect(existsSync(absentRoot)).toBe(false);
  });

  it('Given an orchestrator ledger escaping the config root, When apply is requested, Then traversal is refused before filesystem writes', async () => {
    const refs = await configureIagMcpFixture({ root, dryRun: false, authorityKind: 'ordinary_active' });
    const config = JSON.parse(readFileSync(refs.configPath, 'utf8')) as {
      orchestrator: { ledgerPath: string };
    };
    escapedLedgerPath = join(tmpdir(), `${basename(root)}-escaped.jsonl`);
    config.orchestrator.ledgerPath = escapedLedgerPath;
    writeFileSync(refs.configPath, JSON.stringify(config));

    await expect(tool('sangfor_iag_exception_apply')({
      actionPath: refs.actionPath, configPath: refs.configPath,
      approvalEnvelopePath: refs.approvalEnvelopePath,
    })).rejects.toThrow(/IAG_TOOL_PATH_REFUSED/u);
    expect(existsSync(escapedLedgerPath)).toBe(false);
    expect(refs.fixture.adapterFixture.dispatches).toHaveLength(0);
  });

  it('Given two forwarding wrappers over one execution port, When the production catalog composes IAG dry-run, Then shared authority is refused', async () => {
    const refs = await configureIagMcpFixture({ root, dryRun: true });
    configureIagOrchestratorToolService(undefined);
    const underlying = refs.fixture.adapterFixture.executionPort;
    const catalog = iagOrchestratorToolCatalog(() => ({
      executionPort: createBrowserExecutionAuthorityPort(underlying),
      readBackPort: createBrowserExecutionAuthorityPort(underlying),
    }));

    expect(() => catalog.sangfor_iag_exception_dry_run?.handler({
      actionPath: refs.actionPath, configPath: refs.configPath,
    })).toThrow('IAG_INDEPENDENT_READ_BACK_PORT_REQUIRED');
    expect(refs.fixture.adapterFixture.dispatches).toHaveLength(0);
  });

  it('Given the advisor and operator profiles, When IAG tools are inventoried, Then dry-run remains read-only while apply remains approval-gated and full-only', async () => {
    const listed = new Map(mcp.listTools().map((entry) => [entry.name, entry]));
    const advisor = mcp.listToolsForProfile('advisor');
    const operator = mcp.listToolsForProfile('operator');

    expect(listed.get('sangfor_iag_exception_dry_run')?.annotations).toMatchObject({
      readOnlyHint: true, destructiveHint: false,
    });
    expect(listed.get('sangfor_iag_exception_apply')?.annotations).toMatchObject({
      readOnlyHint: false, destructiveHint: true,
    });
    expect(advisor.map((entry) => entry.name)).toContain('sangfor_iag_exception_dry_run');
    expect(advisor.map((entry) => entry.name)).not.toContain('sangfor_iag_exception_apply');
    expect(operator.map((entry) => entry.name)).not.toContain('sangfor_iag_exception_apply');
  });

  it('Given ordinary active authority and a signed envelope reference, When apply and status run, Then verified terminal truth is stable', async () => {
    const refs = await configureIagMcpFixture({ root, dryRun: false, authorityKind: 'ordinary_active' });

    const applied = await tool('sangfor_iag_exception_apply')({
      actionPath: refs.actionPath, configPath: refs.configPath,
      approvalEnvelopePath: refs.approvalEnvelopePath,
    });
    if (typeof applied !== 'object' || applied === null) throw new TypeError('IAG_APPLY_RESULT_INVALID');
    const runId = Reflect.get(applied, 'runId');
    if (typeof runId !== 'string') throw new TypeError('IAG_APPLY_RUN_ID_MISSING');
    const status = await tool('sangfor_iag_exception_status')({
      configPath: refs.configPath, runId,
    });

    expect(applied).toMatchObject({ outcome: 'SUCCEEDED', verifiedSuccess: true, finalReadBack: 'MATCHED' });
    expect(status).toEqual(applied);
    expect(refs.fixture.adapterFixture.dispatches).toHaveLength(1);
  });

  it('Given loopback HTTP and both signed approvals, When ordinary apply crosses the shared bridge guard, Then verified mock terminal truth returns', async () => {
    const refs = await configureIagMcpFixture({ root, dryRun: false, authorityKind: 'ordinary_active' });
    const secret = process.env.SANGFOR_OPERATOR_APPROVAL_SECRET;
    if (secret === undefined) throw new TypeError('BRIDGE_APPROVAL_SECRET_MISSING');
    const approvalFields = {
      approvedBy: 'operator-16', changeTicketId: 'CHG-16', rollbackPlanId: 'RB-16',
      nonce: 'bridge-iag-ordinary-apply', expiresAt: new Date(Date.now() + 60_000).toISOString(),

    authorityEpoch: 0,};
    const approval = {
      ...approvalFields,
      approvalToken: signApprovalToken(secret, {
        type: 'bridge.tool-call', target: 'sangfor_iag_exception_apply',
      }, approvalFields),
    };
    const mcpRequest: McpRequestFn = async (method, params) => {
      const response = await mcp.handle({ jsonrpc: '2.0', id: 1, method, params });
      if ('error' in response && response.error !== undefined) return { jsonrpc: '2.0', id: 1, error: response.error };
      return { jsonrpc: '2.0', id: 1, result: response.result };
    };
    const server = createBridgeServer({ remoteBind: false, mcpRequest });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new TypeError('BRIDGE_LISTENER_ADDRESS_INVALID');
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/tools/call`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'sangfor_iag_exception_apply', approval,
          arguments: {
            actionPath: refs.actionPath, configPath: refs.configPath,
            approvalEnvelopePath: refs.approvalEnvelopePath,
          },
        }),
      });
      const body: unknown = await response.json();
      expect(response.status).toBe(200);
      expect(body).toMatchObject({ result: { structuredContent: { outcome: 'SUCCEEDED', verifiedSuccess: true } } });
      expect(refs.fixture.adapterFixture.dispatches).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    }
  });

  it('Given candidate-only authority, When ordinary apply is requested, Then it refuses before dispatch', async () => {
    const refs = await configureIagMcpFixture({ root, dryRun: false });

    const result = await tool('sangfor_iag_exception_apply')({
      actionPath: refs.actionPath, configPath: refs.configPath,
      approvalEnvelopePath: refs.approvalEnvelopePath,
    });

    expect(result).toMatchObject({ outcome: 'REFUSED', reasonCode: 'ORDINARY_AUTHORITY_REQUIRED' });
    expect(refs.fixture.adapterFixture.dispatches).toHaveLength(0);
  });

  it('Given a corrupt orchestrator store, When status is requested, Then authenticated lookup fails closed', async () => {
    const refs = await configureIagMcpFixture({ root, dryRun: true });
    writeFileSync(refs.fixture.ledgerPath, '{corrupt-ledger');

    expect(() => tool('sangfor_iag_exception_status')({
      configPath: refs.configPath, runId: 'a'.repeat(64),
    })).toThrow('IAG_ORCHESTRATOR_STORE_UNAVAILABLE');
    expect(refs.fixture.adapterFixture.dispatches).toHaveLength(0);
  });

  it('Given the legacy apply tool has no executor, When called through MCP, Then it returns a typed refusal rather than success', async () => {
    const plan = generateProductChangePlan({ product: 'IAG', requirements: ['Allow one reviewed URL exception'] });

    const response = await mcp.handle({
      jsonrpc: '2.0', id: 16, method: 'tools/call',
      params: { name: 'sangfor_apply_approved_product_change', arguments: { plan } },
    });

    const result = response.result;
    if (typeof result !== 'object' || result === null || !('structuredContent' in result)) {
      throw new TypeError('LEGACY_APPLY_MCP_RESULT_INVALID');
    }
    expect(result.structuredContent).toMatchObject({
      ok: false, code: 'LEGACY_PRODUCT_APPLY_DEPRECATED', mutationPerformed: false,
    });
  });

  it('Given missing approval/config and unknown run references, When tools are called, Then each boundary refuses', async () => {
    const refs = await configureIagMcpFixture({ root, dryRun: false, authorityKind: 'ordinary_active' });

    await expect(tool('sangfor_iag_exception_apply')({
      actionPath: refs.actionPath, configPath: refs.configPath,
    })).rejects.toThrow();
    await expect(tool('sangfor_iag_exception_dry_run')({
      actionPath: refs.actionPath, configPath: join(root, 'missing.json'),
    })).rejects.toThrow();
    expect(() => tool('sangfor_iag_exception_status')({
      configPath: refs.configPath, runId: 'a'.repeat(64),
    })).toThrow('IAG_RUN_NOT_FOUND');
    expect(refs.fixture.adapterFixture.dispatches).toHaveLength(0);
  });
});
