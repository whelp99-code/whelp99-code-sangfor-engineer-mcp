import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { maskSecrets, scrubSecretValues } from '@sangfor/runs';
import { maskSecrets as hciMaskSecrets } from '@sangfor/hci-client';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunStore, type RunRecord } from '@sangfor/runs';

// §4.6 마스킹 계약: /password|secret|token|authorization|cookie/i 키 + string 값 → '***'
describe('maskSecrets — @sangfor/runs 복제본 (T-RUN-2)', () => {
  const fixture = {
    username: 'admin',
    password: 'p@ss',
    nested: {
      apiToken: 'tok123',
      Authorization: 'Bearer x',
      list: [{ cookie: 'c=1', keep: 42 }],
    },
    secretNote: 'text',
    count: 3,
  };

  it('masks matching keys with string values, recursively, arrays included', () => {
    const masked = maskSecrets(fixture) as typeof fixture;
    expect(masked.password).toBe('***');
    expect(masked.nested.apiToken).toBe('***');
    expect(masked.nested.Authorization).toBe('***');
    expect(masked.nested.list[0].cookie).toBe('***');
    expect(masked.secretNote).toBe('***'); // 'secret' substring match
    expect(masked.username).toBe('admin');
    expect(masked.nested.list[0].keep).toBe(42);
    expect(masked.count).toBe(3);
  });

  it('does not mutate the input and leaves non-string secret values untouched', () => {
    const input = { password: 123, meta: { token: true } };
    const masked = maskSecrets(input) as typeof input;
    expect(masked.password).toBe(123);
    expect(masked.meta.token).toBe(true);
    expect(input.password).toBe(123);
  });

  it('behaves identically to the hci-client original (regex 계약 동기화 고정)', () => {
    expect(maskSecrets(fixture)).toEqual(hciMaskSecrets(fixture));
  });

  it('scrubSecretValues masks secret VALUES embedded in free text (error messages)', () => {
    const args = { username: 'admin', password: 'hunter2', nested: { apiToken: 'tok123' } };
    expect(scrubSecretValues('auth failed for admin with password hunter2 (token tok123)', args))
      .toBe('auth failed for admin with password *** (token ***)');
    expect(scrubSecretValues('no secrets here', args)).toBe('no secrets here');
  });
});

const tick = () => new Promise((r) => setTimeout(r, 5)); // requestedAt(ms) 정렬 결정성

describe('RunStore — 라이프사이클/영속/필터 (T-RUN-1)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'runs-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('immediate execution lifecycle: running → succeeded', () => {
    const store = new RunStore(dir);
    const run = store.createRun({
      toolId: 'sangfor.products', toolSafety: 'read_only',
      args: { q: 'hci' }, initialStatus: 'running',
    });
    expect(run.runId).toMatch(/^run_/);
    expect(run.schemaVersion).toBe(1);
    const done = store.transition(run.runId, {
      status: 'succeeded', resultJson: { ok: true }, resultSummary: 'ok',
      durationMs: 12, finishedAt: new Date().toISOString(),
    });
    expect(done.status).toBe('succeeded');
    expect(store.getRun(run.runId)?.status).toBe('succeeded');
  });

  it('approval lifecycle: pending_approval → running(approval meta) → succeeded, 큐 비워짐', () => {
    const store = new RunStore(dir);
    const run = store.createRun({
      toolId: 'sangfor.pm_create_engagement', toolSafety: 'write',
      args: { customer: 'acme' }, initialStatus: 'pending_approval',
    });
    expect(store.pendingApprovals().map((r) => r.runId)).toContain(run.runId);
    store.transition(run.runId, {
      status: 'running',
      approval: { approvedBy: 'jmpark', approvedAt: new Date().toISOString(), changeTicketId: 'CHG-1', rollbackPlanId: 'RB-1' },
    });
    store.transition(run.runId, { status: 'succeeded', finishedAt: new Date().toISOString() });
    expect(store.pendingApprovals()).toHaveLength(0);
    const final = store.getRun(run.runId)!;
    expect(final.approval?.approvedBy).toBe('jmpark');
    expect(final.status).toBe('succeeded');
  });

  it('reject lifecycle + unknown runId transition throws', () => {
    const store = new RunStore(dir);
    const run = store.createRun({ toolId: 't', toolSafety: 'write', args: {}, initialStatus: 'pending_approval' });
    const rejected = store.transition(run.runId, { status: 'rejected', rejectedReason: 'no ticket' });
    expect(rejected.rejectedReason).toBe('no ticket');
    expect(() => store.transition('run_none', { status: 'failed' })).toThrow(/unknown runId/);
  });

  it('재기동 생존: 새 RunStore 인스턴스가 last-wins fold로 최종 상태를 읽는다', () => {
    const a = new RunStore(dir);
    const run = a.createRun({ toolId: 't', toolSafety: 'read_only', args: {}, initialStatus: 'running' });
    a.transition(run.runId, { status: 'failed', error: 'boom' });
    const b = new RunStore(dir);
    expect(b.getRun(run.runId)?.status).toBe('failed');
    expect(b.getRun(run.runId)?.error).toBe('boom');
  });

  it('requestedAt 내림차순 정렬 + limit + 필터(status/toolId/deviceId/sweepId)', async () => {
    const store = new RunStore(dir);
    const r1 = store.createRun({ toolId: 'a', toolSafety: 'read_only', args: {}, deviceId: 'dev_1', initialStatus: 'running' });
    await tick();
    const r2 = store.createRun({ toolId: 'b', toolSafety: 'read_only', args: {}, sweepId: 'sweep_1', initialStatus: 'running' });
    await tick();
    const r3 = store.createRun({ toolId: 'a', toolSafety: 'write', args: {}, initialStatus: 'pending_approval' });
    const all = store.listRuns();
    expect(all.map((r) => r.runId)).toEqual([r3.runId, r2.runId, r1.runId]);
    expect(store.listRuns({ limit: 2 })).toHaveLength(2);
    expect(store.listRuns({ toolId: 'a' }).map((r) => r.runId).sort()).toEqual([r1.runId, r3.runId].sort());
    expect(store.listRuns({ deviceId: 'dev_1' })[0].runId).toBe(r1.runId);
    expect(store.listRuns({ sweepId: 'sweep_1' })[0].runId).toBe(r2.runId);
    expect(store.listRuns({ status: 'pending_approval' })[0].runId).toBe(r3.runId);
  });

  it('sinceDays: 오래된 파일은 기본(14일) 스캔에서 제외, sinceDays 확대 시 포함', () => {
    const store = new RunStore(dir);
    const old: RunRecord = {
      schemaVersion: 1, runId: 'run_old', toolId: 'a', toolSafety: 'read_only',
      args: {}, status: 'succeeded', requestedAt: '2020-01-01T00:00:00.000Z',
    };
    writeFileSync(join(dir, '2020-01-01.jsonl'), `${JSON.stringify(old)}\n`);
    expect(store.listRuns().find((r) => r.runId === 'run_old')).toBeUndefined();
    expect(store.listRuns({ sinceDays: 10_000 }).find((r) => r.runId === 'run_old')).toBeDefined();
    expect(store.getRun('run_old')?.status).toBe('succeeded'); // getRun은 전 파일 스캔
  });

  it('파싱 불가 줄은 경고 후 skip (파일 전체를 버리지 않는다)', () => {
    const store = new RunStore(dir);
    const run = store.createRun({ toolId: 't', toolSafety: 'read_only', args: {}, initialStatus: 'running' });
    appendFileSync(join(dir, `${run.requestedAt.slice(0, 10)}.jsonl`), 'not-json\n');
    expect(store.listRuns().map((r) => r.runId)).toContain(run.runId);
  });
});

describe('RunStore — 마스킹·용량 불변식 (T-RUN-2)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'runs-mask-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('createRun과 transition은 저장 직전 args/resultJson을 강제 마스킹한다', () => {
    const store = new RunStore(dir);
    const run = store.createRun({
      toolId: 't', toolSafety: 'read_only',
      args: { host: 'h', password: 'hunter2', nested: { apiToken: 'x' } },
      initialStatus: 'running',
    });
    expect(run.args.password).toBe('***');
    expect((run.args.nested as Record<string, unknown>).apiToken).toBe('***');
    const done = store.transition(run.runId, { status: 'succeeded', resultJson: { secretKey: 'v', keep: 1 } });
    expect((done.resultJson as Record<string, unknown>).secretKey).toBe('***');
    expect((done.resultJson as Record<string, unknown>).keep).toBe(1);
  });

  it('resultJson 500KB 초과 시 truncated 마커로 대체, resultSummary는 유지', () => {
    const store = new RunStore(dir);
    const run = store.createRun({ toolId: 't', toolSafety: 'read_only', args: {}, initialStatus: 'running' });
    const done = store.transition(run.runId, {
      status: 'succeeded', resultSummary: 'big', resultJson: { blob: 'x'.repeat(600_000) },
    });
    expect(done.resultJson).toEqual({ truncated: true, note: 'result exceeded 500KB' });
    expect(done.resultSummary).toBe('big');
  });
});
