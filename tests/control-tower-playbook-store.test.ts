import { testLocalWriteAuthority } from './helpers/local-write-authority.js';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PlaybookStore, PlaybookValidationError, type PlaybookBlock } from '../apps/control-tower/src/playbook-store.js';
import { AnalysisStore, AgentTaskStore, type PlaybookAnalysis } from '../apps/control-tower/src/playbook-store.js';
import { RuntimeSchemaError } from '../packages/shared/src/runtime-schema.js';

const READ2: PlaybookBlock[] = [
  { id: 'b1', type: 'tool', toolId: 'sangfor_advisor_fortios_advanced', deviceId: 'dev_1' },
  { id: 'r1', type: 'report', title: '종합 리포트' },
];

describe('PlaybookStore — CRUD·검증·상태기계 (T-PB-1)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pb-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('create → rev 1 draft, get/list 왕복, 재로드 생존', async () => {
    const store = new PlaybookStore(dir, testLocalWriteAuthority('registry_services', dir));
    const pb = await store.create({ name: '자문 루프', goal: '전체분석→보고서', blocks: READ2, authoredBy: 'agent:claude', note: '조립근거' });
    expect(pb.id).toMatch(/^pb_/);
    expect(pb.revisions).toHaveLength(1);
    expect(pb.revisions[0]).toMatchObject({ rev: 1, status: 'draft', authoredBy: 'agent:claude', note: '조립근거' });
    expect(store.get(pb.id)!.name).toBe('자문 루프');
    expect(new PlaybookStore(dir, testLocalWriteAuthority('registry_services', dir)).get(pb.id)).toBeDefined(); // atomic write 후 재로드
    expect(store.activeRevision(pb)).toBeUndefined(); // 아직 승인본 없음
  });

  it('블록 검증 fail-closed: 빈 blocks / 중복 id / tool에 toolId 없음 / report에 args / report 2개', async () => {
    const store = new PlaybookStore(dir, testLocalWriteAuthority('registry_services', dir));
    const base = { name: 'x', goal: 'g', authoredBy: 'a' };
    await expect(async () => await store.create({ ...base, blocks: [] })).rejects.toThrow(PlaybookValidationError);
    await expect(async () => await store.create({ ...base, blocks: [{ id: 'b1', type: 'tool', toolId: 't' }, { id: 'b1', type: 'tool', toolId: 't' }] })).rejects.toThrow(/중복/);
    await expect(async () => await store.create({ ...base, blocks: [{ id: 'b1', type: 'tool' }] })).rejects.toThrow(/toolId/);
    await expect(async () => await store.create({ ...base, blocks: [{ id: 'b1', type: 'report', args: { x: 1 } }] })).rejects.toThrow(/report/);
    await expect(async () => await store.create({ ...base, blocks: [{ id: 'r1', type: 'report' }, { id: 'r2', type: 'report' }] })).rejects.toThrow(/report 블록은 최대 1개/);
  });

  it('저장 전 maskSecrets: 블록 args의 비밀 키는 *** (§7.5)', async () => {
    const store = new PlaybookStore(dir, testLocalWriteAuthority('registry_services', dir));
    const pb = await store.create({ name: 'x', goal: 'g', authoredBy: 'a', blocks: [
      { id: 'b1', type: 'tool', toolId: 't', args: { host: 'h', password: 'hunter2', nested: { token: 'x' } } },
    ] });
    const args = pb.revisions[0].blocks[0].args as Record<string, unknown>;
    expect(args.password).toBe('***');
    expect((args.nested as Record<string, unknown>).token).toBe('***');
    expect(args.host).toBe('h'); // 비밀 아닌 키는 보존 → 템플릿도 보존
  });

  it('addRevision → rev N+1 draft, 상태기계: 승인/반려', async () => {
    const store = new PlaybookStore(dir, testLocalWriteAuthority('registry_services', dir));
    const pb = await store.create({ name: 'x', goal: 'g', authoredBy: 'a', blocks: READ2 });
    const r2 = await store.addRevision(pb.id, { blocks: READ2, authoredBy: 'agent:claude', note: '피드백 반영' });
    expect(r2.revisions).toHaveLength(2);
    expect(r2.revisions[1].rev).toBe(2);
    // 반려는 사유 필수
    await expect(async () => await store.reviewRevision(pb.id, 2, { approve: false, reviewedBy: 'jmpark' })).rejects.toThrow(/사유/);
    const rejected = await store.reviewRevision(pb.id, 2, { approve: false, reviewedBy: 'jmpark', rejectReason: 'HA 누락' });
    expect(rejected.revisions[1].status).toBe('rejected');
    expect(rejected.revisions[1].rejectReason).toBe('HA 누락');
    // rev 1 승인 → activeRevision
    const approved = await store.reviewRevision(pb.id, 1, { approve: true, reviewedBy: 'jmpark' });
    expect(store.activeRevision(approved)!.rev).toBe(1);
    // draft 아닌 리비전 재심사 → 409
    await expect(async () => await store.reviewRevision(pb.id, 1, { approve: true, reviewedBy: 'x' }))
      .rejects.toThrow(expect.objectContaining({ status: 409 }));
  });

  it('activeRevision = approved 중 최대 rev', async () => {
    const store = new PlaybookStore(dir, testLocalWriteAuthority('registry_services', dir));
    const pb = await store.create({ name: 'x', goal: 'g', authoredBy: 'a', blocks: READ2 });
    await store.addRevision(pb.id, { blocks: READ2, authoredBy: 'a' });
    await store.reviewRevision(pb.id, 1, { approve: true, reviewedBy: 'j' });
    const p2 = await store.reviewRevision(pb.id, 2, { approve: true, reviewedBy: 'j' });
    expect(store.activeRevision(p2)!.rev).toBe(2);
  });
});

function analysisInput(over: Partial<PlaybookAnalysis> = {}): PlaybookAnalysis {
  return {
    schemaVersion: 1, id: 'anl_seed', playbookId: 'pb_1', playbookRunId: 'pbrun_1',
    summary: 'HA 미설정 2건', authoredBy: 'agent:claude', createdAt: '2026-07-04T00:00:00.000Z',
    improvements: [{ observation: 'HA off', recommendation: 'HA 설정', evidenceRunId: 'run_x' }],
    proposals: [{ action: 'HA 설정 플레이북', rationale: '가용성' }],
    ...over,
  };
}

describe('AnalysisStore — append/fold/verdict·마스킹 (T-PB-2)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'anl-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('append는 id·createdAt를 발급하고 저장 전 maskSecrets, listByRun/get 조회', async () => {
    const store = new AnalysisStore(dir, testLocalWriteAuthority('runs_steps', dir));
    const saved = await store.append(analysisInput({ id: undefined as unknown as string, createdAt: undefined as unknown as string, summary: 'token=abc123 노출', proposals: [{ action: 'x', rationale: 'y', linkedPlaybookId: undefined }] }));
    expect(saved.id).toMatch(/^anl_/);
    expect(saved.createdAt).toBeTruthy();
    expect(store.get(saved.id)!.summary).toBe('token=abc123 노출'); // summary는 키 기반 마스킹 대상 아님 (자유 텍스트)
    expect(store.listByRun('pbrun_1').map((a) => a.id)).toContain(saved.id);
  });

  it('unknown secret-bearing analysis fields produce a typed invalid report without changing bytes', () => {
    // Given
    const store = new AnalysisStore(dir, testLocalWriteAuthority('runs_steps', dir));
    const analysisDir = join(dir, 'analyses');
    const path = join(analysisDir, '2026-08-27.jsonl');
    mkdirSync(analysisDir, { recursive: true });
    const malformed = { ...analysisInput({ id: 'analysis-bad', createdAt: '2026-08-27T00:00:00.000Z' }), token: 'should-not-echo' };
    const prior = `${JSON.stringify(malformed)}\n`;
    writeFileSync(path, prior);

    // When
    const read = () => store.get('analysis-bad');

    // Then
    expect(read).toThrow(RuntimeSchemaError);
    expect(readFileSync(path, 'utf8')).toBe(prior);
  });

  it('setVerdict: improvements/proposals 항목 갱신은 새 스냅샷 append (fold last-wins), 범위 밖 400', async () => {
    const store = new AnalysisStore(dir, testLocalWriteAuthority('runs_steps', dir));
    const a = await store.append(analysisInput({ id: undefined as unknown as string, createdAt: undefined as unknown as string }));
    const v = await store.setVerdict(a.id, 'improvements', 0, 'accepted', 'jmpark');
    expect(v.improvements[0].verdict).toBe('accepted');
    expect(v.improvements[0].reviewedBy).toBe('jmpark');
    const v2 = await store.setVerdict(a.id, 'proposals', 0, 'accepted', 'jmpark', 'pb_next');
    expect(v2.proposals[0].linkedPlaybookId).toBe('pb_next');
    // 재조회 시 최신 스냅샷 (fold)
    expect(store.get(a.id)!.proposals[0].linkedPlaybookId).toBe('pb_next');
    await expect(async () => await store.setVerdict(a.id, 'improvements', 9, 'accepted', 'x')).rejects.toThrow(expect.objectContaining({ status: 400 }));
    await expect(async () => await store.setVerdict('anl_none', 'improvements', 0, 'accepted', 'x')).rejects.toThrow(expect.objectContaining({ status: 404 }));
  });
});

describe('AgentTaskStore — 큐 상태기계 (T-PB-2)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'atask-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('create(open) → close(done) / cancel, open 아니면 409, 저장 전 maskSecrets', async () => {
    const store = new AgentTaskStore(dir, testLocalWriteAuthority('pm_tasks', dir));
    const t = await store.create({ kind: 'assemble', payload: { goal: '전체분석', feedback: undefined } });
    expect(t.id).toMatch(/^atask_/);
    expect(t.status).toBe('open');
    expect(store.list('open').map((x) => x.id)).toContain(t.id);
    const done = await store.close(t.id, { playbookId: 'pb_1', rev: 1 });
    expect(done.status).toBe('done');
    expect(done.result!.playbookId).toBe('pb_1');
    expect(store.list('open')).toHaveLength(0);
    // 이미 done → 재close 409
    await expect(async () => await store.close(t.id, {})).rejects.toThrow(expect.objectContaining({ status: 409 }));
    // cancel은 open만
    const t2 = await store.create({ kind: 'analyze', payload: { playbookRunId: 'pbrun_1' } });
    expect((await store.cancel(t2.id)).status).toBe('cancelled');
    await expect(async () => await store.cancel(t2.id)).rejects.toThrow(expect.objectContaining({ status: 409 }));
  });

  it('unknown secret-bearing task payload fields freeze the task store', () => {
    // Given
    const store = new AgentTaskStore(dir, testLocalWriteAuthority('pm_tasks', dir));
    const path = join(dir, 'agent-tasks.json');
    const malformed = [{
      id: 'task-bad', kind: 'assemble', payload: { goal: 'x', token: 'should-not-echo' },
      status: 'open', createdAt: '2026-08-27T00:00:00.000Z',
    }];
    const prior = JSON.stringify(malformed);
    writeFileSync(path, prior);

    // When
    const read = () => store.list('open');

    // Then
    expect(read).toThrow(RuntimeSchemaError);
    expect(readFileSync(path, 'utf8')).toBe(prior);
  });

  it('unknown secret-bearing task result fields freeze the task store', () => {
    // Given
    const store = new AgentTaskStore(dir, testLocalWriteAuthority('pm_tasks', dir));
    const path = join(dir, 'agent-tasks.json');
    const malformed = [{
      id: 'task-bad', kind: 'assemble', payload: { goal: 'x' }, status: 'done',
      result: { playbookId: 'pb-1', token: 'should-not-echo' }, createdAt: '2026-08-27T00:00:00.000Z',
    }];
    const prior = JSON.stringify(malformed);
    writeFileSync(path, prior);

    // When
    const read = () => store.list('done');

    // Then
    expect(read).toThrow(RuntimeSchemaError);
    expect(readFileSync(path, 'utf8')).toBe(prior);
  });
});
