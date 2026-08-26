import { testFileLocalWriteAuthority, testLocalWriteAuthority } from './helpers/local-write-authority.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AuditLedger } from '@sangfor/hci-client';
import { RunStore } from '@sangfor/runs';

// Importing the MCP server module must NOT start the stdio readline loop.
process.env.MCP_NO_SERVE = '1';

let activeEngagementId: () => string | undefined;
let resolveRepoData: (subdir: string, envVar?: string) => string;
let resolveEngagementScopedData: (subdir: string, envVar?: string) => string;
let getToolHandler: (name: string) => ((args: unknown) => unknown) | undefined;

beforeAll(async () => {
  const shared = await import('../packages/shared/src/index.js');
  activeEngagementId = shared.activeEngagementId;
  resolveRepoData = shared.resolveRepoData;
  resolveEngagementScopedData = shared.resolveEngagementScopedData;
  const mcp = await import('../apps/mcp-server/src/index.js');
  getToolHandler = mcp.getToolHandler as typeof getToolHandler;
});

describe('activeEngagementId / resolveEngagementScopedData (@sangfor/shared, W5 C3)', () => {
  let saved: NodeJS.ProcessEnv;
  beforeEach(() => { saved = { ...process.env }; });
  afterEach(() => { process.env = saved; });

  it('is undefined when SANGFOR_ENGAGEMENT_ID is unset or blank', () => {
    delete process.env.SANGFOR_ENGAGEMENT_ID;
    expect(activeEngagementId()).toBeUndefined();
    process.env.SANGFOR_ENGAGEMENT_ID = '   ';
    expect(activeEngagementId()).toBeUndefined();
  });

  it('returns a valid id unchanged', () => {
    process.env.SANGFOR_ENGAGEMENT_ID = 'acme-2026.q1_pilot';
    expect(activeEngagementId()).toBe('acme-2026.q1_pilot');
  });

  it('throws (fail loud) on an id containing ".." or characters outside [A-Za-z0-9._-]', () => {
    process.env.SANGFOR_ENGAGEMENT_ID = '../escape';
    expect(() => activeEngagementId()).toThrow(/Invalid SANGFOR_ENGAGEMENT_ID/);
    process.env.SANGFOR_ENGAGEMENT_ID = 'has/slash';
    expect(() => activeEngagementId()).toThrow(/Invalid SANGFOR_ENGAGEMENT_ID/);
    process.env.SANGFOR_ENGAGEMENT_ID = 'has space';
    expect(() => activeEngagementId()).toThrow(/Invalid SANGFOR_ENGAGEMENT_ID/);
    // '.' joins back to the unscoped base — an "enabled" scope with zero isolation
    process.env.SANGFOR_ENGAGEMENT_ID = '.';
    expect(() => activeEngagementId()).toThrow(/Invalid SANGFOR_ENGAGEMENT_ID/);
  });

  it('throws on an id longer than 64 chars', () => {
    process.env.SANGFOR_ENGAGEMENT_ID = 'a'.repeat(65);
    expect(() => activeEngagementId()).toThrow(/Invalid SANGFOR_ENGAGEMENT_ID/);
  });

  it('resolveEngagementScopedData is byte-identical to resolveRepoData when unset', () => {
    delete process.env.SANGFOR_ENGAGEMENT_ID;
    expect(resolveEngagementScopedData('data/runs', 'SANGFOR_RUNS_ROOT')).toBe(resolveRepoData('data/runs', 'SANGFOR_RUNS_ROOT'));
  });

  it('resolveEngagementScopedData appends the engagement id as a path segment when active', () => {
    process.env.SANGFOR_ENGAGEMENT_ID = 'acme-1';
    const base = resolveRepoData('data/runs', 'SANGFOR_RUNS_ROOT');
    expect(resolveEngagementScopedData('data/runs', 'SANGFOR_RUNS_ROOT')).toBe(join(base, 'acme-1'));
  });
});

describe('RunStore — engagement scoping isolates the runs root (W5 C3)', () => {
  let saved: NodeJS.ProcessEnv;
  let root: string;
  beforeEach(() => {
    saved = { ...process.env };
    root = mkdtempSync(join(tmpdir(), 'engagement-runs-'));
    process.env.SANGFOR_RUNS_ROOT = root;
  });
  afterEach(() => {
    process.env = saved;
    rmSync(root, { recursive: true, force: true });
  });

  it('writes into <root> unchanged when no engagement is set', async () => {
    delete process.env.SANGFOR_ENGAGEMENT_ID;
    const store = new RunStore(undefined, testLocalWriteAuthority('runs_steps'));
    const run = await store.createRun({ toolId: 't', toolSafety: 'read_only', args: {}, initialStatus: 'succeeded' });
    const file = join(root, `${run.requestedAt.slice(0, 10)}.jsonl`);
    expect(existsSync(file)).toBe(true);
    expect(existsSync(join(root, 'acme-1'))).toBe(false);
  });

  it('writes into <root>/<engagementId> when an engagement is set', async () => {
    process.env.SANGFOR_ENGAGEMENT_ID = 'acme-1';
    const store = new RunStore(undefined, testLocalWriteAuthority('runs_steps'));
    const run = await store.createRun({ toolId: 't', toolSafety: 'read_only', args: {}, initialStatus: 'succeeded' });
    const scopedFile = join(root, 'acme-1', `${run.requestedAt.slice(0, 10)}.jsonl`);
    expect(existsSync(scopedFile)).toBe(true);
    // Nothing lands directly under the unscoped root.
    expect(existsSync(join(root, `${run.requestedAt.slice(0, 10)}.jsonl`))).toBe(false);
  });
});

describe('sangfor_rag_search search-gap capture — engagement scoping isolates the feedback root (W5 C3)', () => {
  let saved: NodeJS.ProcessEnv;
  let feedbackRoot: string;
  beforeEach(() => {
    saved = { ...process.env };
    feedbackRoot = mkdtempSync(join(tmpdir(), 'engagement-feedback-'));
    process.env.SANGFOR_FEEDBACK_ROOT = feedbackRoot;
    delete process.env.SANGFOR_SEARCH_GAP_CAPTURE;
    delete process.env.SANGFOR_RAG_WEAK_THRESHOLD;
  });
  afterEach(() => {
    process.env = saved;
    rmSync(feedbackRoot, { recursive: true, force: true });
  });

  it('writes search-gaps.jsonl under <feedbackRoot> when no engagement is set', async () => {
    delete process.env.SANGFOR_ENGAGEMENT_ID;
    const handler = getToolHandler('sangfor_rag_search')!;
    await handler({ query: 'unscoped gap query', indexPath: join(feedbackRoot, 'does-not-exist.json') });
    expect(existsSync(join(feedbackRoot, 'search-gaps.jsonl'))).toBe(true);
    expect(existsSync(join(feedbackRoot, 'acme-1', 'search-gaps.jsonl'))).toBe(false);
  });

  it('writes search-gaps.jsonl under <feedbackRoot>/<engagementId> when an engagement is set', async () => {
    process.env.SANGFOR_ENGAGEMENT_ID = 'acme-1';
    const handler = getToolHandler('sangfor_rag_search')!;
    await handler({ query: 'scoped gap query', indexPath: join(feedbackRoot, 'does-not-exist-2.json') });
    expect(existsSync(join(feedbackRoot, 'acme-1', 'search-gaps.jsonl'))).toBe(true);
    expect(existsSync(join(feedbackRoot, 'search-gaps.jsonl'))).toBe(false);
  });
});

describe('sangfor_session_report save path — engagement scoping isolates data/evidence/reports (W5 C3)', () => {
  let saved: NodeJS.ProcessEnv;
  let root: string;
  beforeEach(() => {
    saved = { ...process.env };
    root = mkdtempSync(join(tmpdir(), 'engagement-evidence-'));
    process.env.SANGFOR_EVIDENCE_ROOT = root;
    delete process.env.SANGFOR_CHANGE_LEDGER_SECRET;
  });
  afterEach(() => {
    process.env = saved;
    rmSync(root, { recursive: true, force: true });
  });

  it('saves under <root>/reports/<runId>.md when no engagement is set (unchanged behavior)', async () => {
    delete process.env.SANGFOR_ENGAGEMENT_ID;
    const ledger = new AuditLedger({ dir: join(root, 'change-runs') , authority: testLocalWriteAuthority('audit', join(root, 'change-runs'))});
    const runId = 'run_unscoped';
    await ledger.append(runId, 'state', { state: 'PENDING' });
    const handler = getToolHandler('sangfor_session_report')!;
    const result: any = handler({ runId, save: true });
    const expectedPath = join(root, 'reports', `${runId}.md`);
    expect(result.savedPath).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);
  });

  it('saves under <root>/<engagementId>/reports/<runId>.md when an engagement is set', async () => {
    process.env.SANGFOR_ENGAGEMENT_ID = 'acme-1';
    const ledger = new AuditLedger({ dir: join(root, 'change-runs') , authority: testLocalWriteAuthority('audit', join(root, 'change-runs'))});
    const runId = 'run_scoped';
    await ledger.append(runId, 'state', { state: 'PENDING' });
    const handler = getToolHandler('sangfor_session_report')!;
    const result: any = handler({ runId, save: true });
    const expectedPath = join(root, 'acme-1', 'reports', `${runId}.md`);
    expect(result.savedPath).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);
  });
});

describe('sangfor_engagement_scope tool (W5 C3)', () => {
  let saved: NodeJS.ProcessEnv;
  beforeEach(() => { saved = { ...process.env }; });
  afterEach(() => { process.env = saved; });

  it('is read-only and never destructive', async () => {
    const mcp = await import('../apps/mcp-server/src/index.js');
    const tool = (mcp as any).listTools().find((t: any) => t.name === 'sangfor_engagement_scope');
    expect(tool).toBeTruthy();
    expect(tool.annotations.readOnlyHint).toBe(true);
    expect(tool.annotations.destructiveHint).toBe(false);
  });

  it('reports active:false and unscoped repo-relative roots when no engagement is set', () => {
    delete process.env.SANGFOR_ENGAGEMENT_ID;
    delete process.env.SANGFOR_RUNS_ROOT;
    delete process.env.SANGFOR_FEEDBACK_ROOT;
    delete process.env.SANGFOR_EVIDENCE_ROOT;
    const handler = getToolHandler('sangfor_engagement_scope')!;
    const result: any = handler({});
    expect(result.active).toBe(false);
    expect(result.engagementId).toBeUndefined();
    expect(result.scopedRoots).toEqual([
      { name: 'runs', path: 'data/runs' },
      { name: 'search-gaps-feedback', path: 'data/feedback' },
      { name: 'session-reports', path: 'data/evidence/reports' },
    ]);
  });

  it('reports active:true and the engagement-suffixed roots when an engagement is set', () => {
    process.env.SANGFOR_ENGAGEMENT_ID = 'acme-1';
    delete process.env.SANGFOR_RUNS_ROOT;
    delete process.env.SANGFOR_FEEDBACK_ROOT;
    delete process.env.SANGFOR_EVIDENCE_ROOT;
    const handler = getToolHandler('sangfor_engagement_scope')!;
    const result: any = handler({});
    expect(result.active).toBe(true);
    expect(result.engagementId).toBe('acme-1');
    expect(result.scopedRoots).toEqual([
      { name: 'runs', path: join('data/runs', 'acme-1') },
      { name: 'search-gaps-feedback', path: join('data/feedback', 'acme-1') },
      { name: 'session-reports', path: join('data/evidence', 'acme-1', 'reports') },
    ]);
  });

  it('throws on an invalid SANGFOR_ENGAGEMENT_ID instead of silently falling back', () => {
    process.env.SANGFOR_ENGAGEMENT_ID = '../escape';
    const handler = getToolHandler('sangfor_engagement_scope')!;
    expect(() => handler({})).toThrow(/Invalid SANGFOR_ENGAGEMENT_ID/);
  });
});
