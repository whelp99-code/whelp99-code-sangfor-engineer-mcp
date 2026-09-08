import { testFileLocalWriteAuthority, testLocalWriteAuthority } from './helpers/local-write-authority.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AuditLedger } from '@sangfor/hci-client';

// Importing the MCP server module must NOT start the stdio readline loop.
process.env.MCP_NO_SERVE = '1';

let getToolHandler: (name: string) => ((args: unknown) => unknown) | undefined;
let listTools: () => Array<{ name: string; annotations?: any }>;

beforeAll(async () => {
  const mod = await import('../apps/mcp-server/src/index.js');
  getToolHandler = mod.getToolHandler as typeof getToolHandler;
  listTools = (mod as any).listTools;
});

describe('sangfor_session_report (W4 C1)', () => {
  let saved: NodeJS.ProcessEnv;
  let root: string;

  beforeEach(() => {
    saved = { ...process.env };
    root = mkdtempSync(join(tmpdir(), 'session-report-'));
    process.env.SANGFOR_EVIDENCE_ROOT = root;
    // buildChangeRunReport's internal AuditLedger verifies against this env
    // var (same default AuditLedger itself uses) — isolate it so an unkeyed
    // manually-appended fixture ledger always matches the internal verify().
    delete process.env.SANGFOR_CHANGE_LEDGER_SECRET;
  });
  afterEach(() => {
    process.env = saved;
    rmSync(root, { recursive: true, force: true });
  });

  it('carries readOnlyHint:false, destructiveHint:false (save-capable local artifact write, matching sangfor_generate_evidence_report convention)', () => {
    const tool = listTools().find((t) => t.name === 'sangfor_session_report');
    expect(tool).toBeTruthy();
    expect(tool!.annotations.readOnlyHint).toBe(false);
    expect(tool!.annotations.destructiveHint).toBe(false);
  });

  it('with no runId, returns only the list of available change-run ids (read-only discovery)', async () => {
    const ledger = new AuditLedger({ dir: join(root, 'change-runs') , authority: testLocalWriteAuthority('audit', join(root, 'change-runs'))});
    await ledger.append('run_x', 'state', { state: 'PENDING' });
    await ledger.append('run_a', 'state', { state: 'PENDING' });
    const handler = getToolHandler('sangfor_session_report')!;
    const result: any = handler({});
    expect(result.availableRunIds).toEqual(['run_a', 'run_x']);
    expect(result.report).toBeUndefined();
  });

  it('rejects a path-traversal runId instead of touching the filesystem', () => {
    const handler = getToolHandler('sangfor_session_report')!;
    const result: any = handler({ runId: '../../etc/passwd' });
    expect(result.error).toMatch(/INVALID_RUN_ID/);
  });

  it('returns a Markdown report for a known runId by default', async () => {
    const ledger = new AuditLedger({ dir: join(root, 'change-runs') , authority: testLocalWriteAuthority('audit', join(root, 'change-runs'))});
    const runId = 'run_report_md';
    await ledger.append(runId, 'state', { state: 'PENDING', detail: 'create-volume test' });
    await ledger.append(runId, 'response', { status: 202 });

    const handler = getToolHandler('sangfor_session_report')!;
    const result: any = handler({ runId });
    expect(result.format).toBe('markdown');
    expect(typeof result.report).toBe('string');
    expect(result.report).toContain(`# Change Run Report — ${runId}`);
    expect(result.savedPath).toBeUndefined();
  });

  it('returns structured JSON when format:"json" is requested', async () => {
    const ledger = new AuditLedger({ dir: join(root, 'change-runs') , authority: testLocalWriteAuthority('audit', join(root, 'change-runs'))});
    const runId = 'run_report_json';
    await ledger.append(runId, 'state', { state: 'PENDING' });

    const handler = getToolHandler('sangfor_session_report')!;
    const result: any = handler({ runId, format: 'json' });
    expect(result.format).toBe('json');
    expect(result.report.runId).toBe(runId);
    expect(result.report.chain).toEqual({ ok: true, keyed: false });
  });

  it('with save:true, atomically writes the Markdown report under data/evidence/reports/<runId>.md and returns the path', async () => {
    const ledger = new AuditLedger({ dir: join(root, 'change-runs') , authority: testLocalWriteAuthority('audit', join(root, 'change-runs'))});
    const runId = 'run_report_save';
    await ledger.append(runId, 'state', { state: 'PENDING' });

    const handler = getToolHandler('sangfor_session_report')!;
    const result: any = handler({ runId, save: true });
    const expectedPath = join(root, 'reports', `${runId}.md`);
    expect(result.savedPath).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);
    expect(readFileSync(expectedPath, 'utf8')).toContain(`# Change Run Report — ${runId}`);
  });
});
