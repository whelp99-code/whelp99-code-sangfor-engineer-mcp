import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { configureIagOrchestratorToolService } from '../apps/mcp-server/src/iag-orchestrator-tools.js';
import { resolveIagMutationActionAuthority } from '../packages/sangfor-competency/src/index.js';
import {
  digestIagMutationAction,
  parseIagMutationAction,
} from '../packages/sangfor-product-adapters/src/apply/index.js';
import {
  consumeIagMutationNonce,
  signIagMutationApproval,
} from '../packages/sangfor-operator/src/index.js';
import { cleanupTestIagMutationAuthorityEnvironment } from './helpers/iag-mutation-contract-fixture.js';
import { configureIagMcpFixture } from './helpers/iag-mcp-tool-fixture.js';
import {
  persistedCounterSchema,
  startIagMcpStdioProcess,
} from './helpers/iag-mcp-stdio-process-fixture.js';
import {
  configureIagOrchestratorTestEnvironment,
  IAG_ORCHESTRATOR_CHECKPOINT_SECRET,
  IAG_ORCHESTRATOR_LEDGER_SECRET,
  IAG_ORCHESTRATOR_NOW,
  IAG_ORDINARY_APPROVAL_SECRET,
  type iagOrchestratorFixture,
} from './helpers/iag-orchestrator-fixture.js';
import {
  changedTerminalReplaySource,
  writeApprovalEnvelope,
} from './helpers/iag-terminal-replay-fixture.js';

process.env.MCP_NO_SERVE = '1';
const domainResultSchema = z.object({
  runId: z.string(), outcome: z.enum(['SUCCEEDED', 'REFUSED']), reasonCode: z.string().optional(),
}).passthrough();
const callSchema = z.object({
  result: z.object({ structuredContent: z.unknown().optional(), isError: z.boolean() }).passthrough(),
}).passthrough();
type Fixture = Awaited<ReturnType<typeof iagOrchestratorFixture>>;
type Refs = Awaited<ReturnType<typeof configureIagMcpFixture>>;
type ProcessFixture = Awaited<ReturnType<typeof startIagMcpStdioProcess>>;
type RunningFixture = { readonly refs: Refs; readonly process: ProcessFixture; readonly first: z.infer<typeof domainResultSchema> };
let root = '';
const processes: ProcessFixture[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'iag-mcp-replay-'));
  configureIagOrchestratorTestEnvironment(root);
  process.env.SANGFOR_IAG_ORCHESTRATOR_LEDGER_SECRET = IAG_ORCHESTRATOR_LEDGER_SECRET;
  process.env.SANGFOR_IAG_ORCHESTRATOR_CHECKPOINT_SECRET = IAG_ORCHESTRATOR_CHECKPOINT_SECRET;
});

afterEach(async () => {
  try {
    await Promise.all(processes.splice(0).map((fixture) => fixture.close()));
  } finally {
    configureIagOrchestratorToolService(undefined);
    cleanupTestIagMutationAuthorityEnvironment();
    for (const key of [
      'SANGFOR_ALLOW_REAL_EXECUTION', 'SANGFOR_ALLOW_PRODUCTION_EXECUTION',
      'SANGFOR_IAG_BOOTSTRAP_APPROVAL_SECRET', 'SANGFOR_OPERATOR_APPROVAL_SECRET',
      'SANGFOR_NONCE_STORE', 'SANGFOR_NONCE_STORE_PATH',
      'SANGFOR_IAG_ORCHESTRATOR_LEDGER_SECRET', 'SANGFOR_IAG_ORCHESTRATOR_CHECKPOINT_SECRET',
    ]) delete process.env[key];
    rmSync(root, { recursive: true, force: true });
  }
});

function args(refs: Refs) {
  return { actionPath: refs.actionPath, configPath: refs.configPath, approvalEnvelopePath: refs.approvalEnvelopePath };
}

function approval(fixture: Fixture, nonce: string, actionDigest = fixture.actionDigest) {
  const fields = {
    approvedBy: 'stdio-replay', changeTicketId: 'CHG-STDIO', rollbackPlanId: 'RB-STDIO',
    purpose: 'ordinary_change' as const, nonce, expiresAt: '2036-08-26T12:00:00.000Z',

  authorityEpoch: 0,};
  const action = fixture.action;
  return { ...fields, approvalToken: signIagMutationApproval(IAG_ORDINARY_APPROVAL_SECRET, {
    actionDigest, origin: action.target.origin, deviceIdentityDigest: action.target.deviceIdentityDigest,
    sessionId: action.target.sessionId, windowId: action.target.windowId,
  }, fields) };
}

async function changedApproval(fixture: Fixture, source: string, nonce: string) {
  const authority = await resolveIagMutationActionAuthority(fixture.authorityRequest);
  if (!authority.ok) throw new TypeError(authority.code);
  const action = parseIagMutationAction({ source, authority: authority.authority });
  if (!action.ok) throw new TypeError(action.refusal.code);
  return approval(fixture, nonce, digestIagMutationAction(action.value));
}

async function call(fixture: ProcessFixture, id: string, name: string, argumentsValue: Record<string, unknown>) {
  return callSchema.parse(await fixture.client.request(id, 'tools/call', { name, arguments: argumentsValue })).result;
}

async function successfulFixture(): Promise<RunningFixture> {
  const refs = await configureIagMcpFixture({ root, dryRun: false, authorityKind: 'ordinary_active' });
  const configSource = readFileSync(refs.configPath, 'utf8');
  writeFileSync(refs.configPath, configSource.replace('"maxAgeMs":7200000', '"maxAgeMs":315360000000'));
  writeApprovalEnvelope(refs.approvalEnvelopePath, approval(refs.fixture, 'stdio-consumed-domain-approval'));
  const processFixture = await startIagMcpStdioProcess({
    root, fixture: refs.fixture,
    environment: {
      SANGFOR_IAG_ORCHESTRATOR_LEDGER_SECRET: IAG_ORCHESTRATOR_LEDGER_SECRET,
      SANGFOR_IAG_ORCHESTRATOR_CHECKPOINT_SECRET: IAG_ORCHESTRATOR_CHECKPOINT_SECRET,
    },
  });
  processes.push(processFixture);
  await processFixture.client.request('initialize', 'initialize', {});
  const first = domainResultSchema.parse((await call(processFixture, 'seed-apply', 'sangfor_iag_exception_apply', args(refs))).structuredContent);
  expect(first.outcome).toBe('SUCCEEDED');
  return { refs, process: processFixture, first };
}

function expectCounters(fixture: RunningFixture): void {
  expect(persistedCounterSchema.parse(JSON.parse(readFileSync(fixture.process.counterPath, 'utf8'))))
    .toEqual({ preflight: 1, dispatch: 1, readBack: 1 });
}

describe('IAG terminal apply replay over real MCP stdio', () => {
  it('Given prior success and a deleted approval file, When exact apply replays, Then MCP errors without extra work', async () => {
    const fixture = await successfulFixture();
    unlinkSync(fixture.refs.approvalEnvelopePath);
    expect((await call(fixture.process, 'deleted', 'sangfor_iag_exception_apply', args(fixture.refs))).isError).toBe(true);
    expectCounters(fixture);
  });

  it('Given prior success and an empty approval, When exact apply replays, Then MCP typed-refuses', async () => {
    const fixture = await successfulFixture();
    writeApprovalEnvelope(fixture.refs.approvalEnvelopePath, {});
    expect(domainResultSchema.parse((await call(fixture.process, 'empty', 'sangfor_iag_exception_apply', args(fixture.refs))).structuredContent))
      .toMatchObject({ outcome: 'REFUSED', reasonCode: 'APPROVAL_FIELDS_REQUIRED' });
    expectCounters(fixture);
  });

  it('Given prior success and consumed approval, When exact apply replays, Then MCP reports APPROVAL_REPLAY', async () => {
    const fixture = await successfulFixture();
    expect(domainResultSchema.parse((await call(fixture.process, 'consumed', 'sangfor_iag_exception_apply', args(fixture.refs))).structuredContent))
      .toMatchObject({ outcome: 'REFUSED', reasonCode: 'APPROVAL_REPLAY' });
    expectCounters(fixture);
  });

  it('Given prior success and fresh approval, When exact apply replays, Then status is required and nonce stays fresh', async () => {
    const fixture = await successfulFixture();
    const fresh = approval(fixture.refs.fixture, 'mcp-fresh-terminal');
    writeApprovalEnvelope(fixture.refs.approvalEnvelopePath, fresh);
    expect(domainResultSchema.parse((await call(fixture.process, 'fresh', 'sangfor_iag_exception_apply', args(fixture.refs))).structuredContent))
      .toMatchObject({ outcome: 'REFUSED', reasonCode: 'RUN_ALREADY_TERMINAL_USE_STATUS' });
    await expect(consumeIagMutationNonce(fresh, IAG_ORCHESTRATOR_NOW)).resolves.toEqual({ ok: true });
    expectCounters(fixture);
  });

  it('Given prior success and changed digest, When old approval applies, Then binding refuses before conflict truth', async () => {
    const fixture = await successfulFixture();
    writeFileSync(fixture.refs.actionPath, changedTerminalReplaySource(fixture.refs.fixture));
    expect(domainResultSchema.parse((await call(fixture.process, 'changed-old', 'sangfor_iag_exception_apply', args(fixture.refs))).structuredContent))
      .toMatchObject({ outcome: 'REFUSED', reasonCode: 'APPROVAL_SIGNATURE_REFUSED' });
    expectCounters(fixture);
  });

  it('Given prior success and changed digest with fresh binding, When apply conflicts, Then nonce stays fresh', async () => {
    const fixture = await successfulFixture();
    const source = changedTerminalReplaySource(fixture.refs.fixture);
    const fresh = await changedApproval(fixture.refs.fixture, source, 'mcp-fresh-conflict');
    writeFileSync(fixture.refs.actionPath, source);
    writeApprovalEnvelope(fixture.refs.approvalEnvelopePath, fresh);
    expect(domainResultSchema.parse((await call(fixture.process, 'changed-fresh', 'sangfor_iag_exception_apply', args(fixture.refs))).structuredContent))
      .toMatchObject({ outcome: 'REFUSED', reasonCode: 'IDEMPOTENCY_CONFLICT' });
    await expect(consumeIagMutationNonce(fresh, IAG_ORCHESTRATOR_NOW)).resolves.toEqual({ ok: true });
    expectCounters(fixture);
  });

  it('Given prior success and corrupt terminal store, When apply replays, Then MCP errors without success leakage', async () => {
    const fixture = await successfulFixture();
    writeFileSync(fixture.refs.fixture.ledgerPath, '{corrupt-terminal');
    expect((await call(fixture.process, 'corrupt', 'sangfor_iag_exception_apply', args(fixture.refs))).isError).toBe(true);
    expectCounters(fixture);
  });

  it('Given prior success, When 32 consumed approvals replay, Then every correlated response REFUSES without mock work', async () => {
    const fixture = await successfulFixture();
    const responses = await Promise.all(Array.from({ length: 32 }, (_, index) => call(
      fixture.process, `replay-${index}`, 'sangfor_iag_exception_apply', args(fixture.refs),
    )));
    const replays = responses.map((response) => domainResultSchema.parse(response.structuredContent));
    const status = await call(fixture.process, 'status', 'sangfor_iag_exception_status', {
      configPath: fixture.refs.configPath, runId: fixture.first.runId,
    });
    expect(replays.every(({ outcome, reasonCode }) => outcome === 'REFUSED' && reasonCode === 'APPROVAL_REPLAY')).toBe(true);
    expect(domainResultSchema.parse(status.structuredContent)).toEqual(fixture.first);
    expectCounters(fixture);
  });

  it('Given this suite source, When transport composition is inspected, Then direct MCP handle calls are absent', () => {
    const source = readFileSync(import.meta.filename, 'utf8');
    expect(source).not.toMatch(new RegExp(['mcp', 'handle\\s*\\('].join('\\.')));
  });
});
