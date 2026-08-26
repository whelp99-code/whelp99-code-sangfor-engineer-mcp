import { testFileLocalWriteAuthority, testLocalWriteAuthority } from './helpers/local-write-authority.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AuditLedger } from '@sangfor/hci-client';
import { buildChangeRunReport, isSafeRunId, listChangeRunIds } from '../packages/sangfor-evidence/src/index.js';

describe('isSafeRunId', () => {
  it('accepts plain id segments', () => {
    expect(isSafeRunId('hci_apply_1785510007962_931f20')).toBe(true);
  });

  it('rejects path traversal and separators', () => {
    expect(isSafeRunId('../../etc/passwd')).toBe(false);
    expect(isSafeRunId('..')).toBe(false);
    expect(isSafeRunId('.')).toBe(false);
    expect(isSafeRunId('a/b')).toBe(false);
    expect(isSafeRunId('a\\b')).toBe(false);
    expect(isSafeRunId('')).toBe(false);
    expect(isSafeRunId(' leading-space')).toBe(false);
    expect(isSafeRunId(123 as unknown as string)).toBe(false);
  });
});

describe('buildChangeRunReport', () => {
  // buildChangeRunReport constructs its own internal AuditLedger with no
  // explicit secret, so — exactly like AuditLedger's own default — it verifies
  // against process.env.SANGFOR_CHANGE_LEDGER_SECRET. Isolate that env var so
  // append (via a manually-constructed AuditLedger below) and this internal
  // verify() always agree on keyed vs unkeyed.
  let root: string;
  let saved: NodeJS.ProcessEnv;
  beforeEach(() => {
    saved = { ...process.env };
    delete process.env.SANGFOR_CHANGE_LEDGER_SECRET;
    root = mkdtempSync(join(tmpdir(), 'change-run-report-'));
  });
  afterEach(() => {
    process.env = saved;
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects an unsafe runId before touching the filesystem', () => {
    expect(() => buildChangeRunReport({ runId: '../escape', ledgerRoot: root })).toThrow(/INVALID_RUN_ID/);
  });

  it('reports found:false with an honest empty report when the ledger file does not exist', () => {
    const { markdown, json } = buildChangeRunReport({ runId: 'run_does_not_exist', ledgerRoot: root });
    expect(json.found).toBe(false);
    expect(json.overview.stepCount).toBe(0);
    expect(json.chain.ok).toBe(true); // an empty chain trivially verifies
    expect(markdown).toContain('Found: no');
  });

  it('builds overview, step timeline, verification and chain integrity from a keyed ledger', async () => {
    // Set the SAME env var buildChangeRunReport's internal verify() will read,
    // rather than a per-instance secret that only the append side would see.
    process.env.SANGFOR_CHANGE_LEDGER_SECRET = 'test-secret';
    const ledger = new AuditLedger({ dir: join(root, 'change-runs') , authority: testLocalWriteAuthority('audit', join(root, 'change-runs'))});
    const runId = 'hci_apply_test_run';
    await ledger.append(runId, 'state', { at: '2026-08-01T00:00:00.000Z', state: 'PENDING', detail: "create-volume 'e2e-vol' (5GB)" });
    await ledger.append(runId, 'state', { at: '2026-08-01T00:00:01.000Z', state: 'APPLYING', detail: 'POST /volumes' });
    await ledger.append(runId, 'request', { op: 'create-volume', name: 'e2e-vol', sizeGb: 5, clientToken: '***' });
    await ledger.append(runId, 'response', { status: 202, volume: { id: 'vol-1', name: 'e2e-vol' } });
    await ledger.append(runId, 'verdict', { verdict: 'PASS', volumeId: 'vol-1' });

    const { markdown, json } = buildChangeRunReport({ runId, ledgerRoot: root });

    expect(json.found).toBe(true);
    expect(json.overview.stepCount).toBe(5);
    expect(json.overview.target).toBe("create-volume 'e2e-vol' (5GB)");
    expect(json.steps).toHaveLength(5);
    expect(json.steps[0].kind).toBe('state');
    expect(json.steps[0].summary).toContain('PENDING');
    expect(json.verification).toHaveLength(1);
    expect(json.verification[0].payload).toMatchObject({ verdict: 'PASS', volumeId: 'vol-1' });
    expect(json.chain).toEqual({ ok: true, keyed: true });

    expect(markdown).toContain(`# Change Run Report — ${runId}`);
    expect(markdown).toContain('## Step Timeline');
    expect(markdown).toContain('## Read-back / Verification');
    expect(markdown).toContain('## Chain Integrity');
    expect(markdown).toContain('ok: true');
    expect(markdown).toContain('keyed: true');
  });

  it('reports an unkeyed chain honestly', async () => {
    const ledger = new AuditLedger({ dir: join(root, 'change-runs') , authority: testLocalWriteAuthority('audit', join(root, 'change-runs'))}); // no secret
    await ledger.append('run_unkeyed', 'state', { state: 'PENDING' });
    const { json, markdown } = buildChangeRunReport({ runId: 'run_unkeyed', ledgerRoot: root });
    expect(json.chain.keyed).toBe(false);
    expect(markdown).toContain('unkeyed chain');
  });

  it('detects a broken chain (tampered payload)', async () => {
    const ledger = new AuditLedger({ dir: join(root, 'change-runs') , authority: testLocalWriteAuthority('audit', join(root, 'change-runs'))}); // unkeyed — matches the isolated env above
    const runId = 'run_tampered';
    await ledger.append(runId, 'state', { a: 1 });
    await ledger.append(runId, 'state', { b: 2 });
    const path = ledger.pathFor(runId);
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    const doctored = JSON.parse(lines[0]);
    doctored.payload = { a: 999 };
    writeFileSync(path, [JSON.stringify(doctored), lines[1]].join('\n') + '\n');

    const { json } = buildChangeRunReport({ runId, ledgerRoot: root });
    expect(json.chain.ok).toBe(false);
    expect(json.chain.brokenAt).toBe(0);
  });

  it('re-masks secret-bearing payload fields at render time (F2 defense in depth), even for a raw ledger line that bypassed AuditLedger.append\'s own write-time masking', () => {
    // AuditLedger.append() already masks secrets before writing — to prove the
    // RENDER side also masks independently, write a raw line directly (bypassing
    // append entirely) with plaintext secret-bearing fields. The chain hash is
    // deliberately not valid here; this test only cares about secret exposure.
    const changeRunsDir = join(root, 'change-runs');
    mkdirSync(changeRunsDir, { recursive: true });
    const runId = 'run_render_mask';
    // kind:'verdict' is the one line kind whose full payload is both dumped
    // into the step summary (JSON.stringify fallback) AND carried verbatim
    // into json.verification[].payload — the fullest render-side exposure
    // surface, so this is where a masking gap would be most visible.
    const rawLine = {
      seq: 0,
      at: '2026-08-01T00:00:00.000Z',
      runId,
      kind: 'verdict',
      payload: { op: 'login', password: 'leak-me-12345', headers: { Authorization: 'Bearer leak-token-xyz' }, cookie: 'session=leak-cookie' },
      prevHash: 'GENESIS',
      hash: 'not-a-real-hash-for-this-test',
      keyed: false,
    };
    writeFileSync(join(changeRunsDir, `${runId}.jsonl`), `${JSON.stringify(rawLine)}\n`);

    const { markdown, json } = buildChangeRunReport({ runId, ledgerRoot: root });
    const rendered = markdown + JSON.stringify(json);
    expect(rendered).not.toContain('leak-me-12345');
    expect(rendered).not.toContain('leak-token-xyz');
    expect(rendered).not.toContain('leak-cookie');
    expect(rendered).toContain('***');
  });

  it('lists screenshot/evidence files whose name references the runId, ignoring unrelated files', async () => {
    const ledger = new AuditLedger({ dir: join(root, 'change-runs') , authority: testLocalWriteAuthority('audit', join(root, 'change-runs'))});
    const runId = 'run_with_shots';
    await ledger.append(runId, 'state', { state: 'PENDING' });
    const sessionDir = join(root, 'session_abc');
    mkdirSync(sessionDir, { recursive: true });
    const shotPath = join(sessionDir, `before-${runId}-1.png`);
    writeFileSync(shotPath, 'fake-png');
    writeFileSync(join(sessionDir, 'unrelated.png'), 'fake-png');

    const { json } = buildChangeRunReport({ runId, ledgerRoot: root });
    expect(json.screenshots).toContain(shotPath);
    expect(json.screenshots).not.toContain(join(sessionDir, 'unrelated.png'));
  });

  it('never writes to disk (pure function)', async () => {
    const ledger = new AuditLedger({ dir: join(root, 'change-runs') , authority: testLocalWriteAuthority('audit', join(root, 'change-runs'))});
    await ledger.append('run_pure', 'state', { state: 'PENDING' });
    const before = readdirSync(root, { recursive: true } as any);
    buildChangeRunReport({ runId: 'run_pure', ledgerRoot: root });
    const after = readdirSync(root, { recursive: true } as any);
    expect(after).toEqual(before);
  });
});

describe('listChangeRunIds', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'change-run-ids-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('returns an empty list when no change-runs directory exists', () => {
    expect(listChangeRunIds(root)).toEqual([]);
  });

  it('lists sorted ids from ledger files, excluding non-jsonl files', async () => {
    const ledger = new AuditLedger({ dir: join(root, 'change-runs'), secret: 's' , authority: testLocalWriteAuthority('audit', join(root, 'change-runs'))});
    await ledger.append('run_b', 'state', { state: 'PENDING' });
    await ledger.append('run_a', 'state', { state: 'PENDING' });
    writeFileSync(join(root, 'change-runs', 'run_b.jsonl.lock'), 'x');
    expect(listChangeRunIds(root)).toEqual(['run_a', 'run_b']);
  });
});
