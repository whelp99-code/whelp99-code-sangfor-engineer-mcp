import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PlaybookStore, PlaybookValidationError, type PlaybookBlock } from '../apps/control-tower/src/playbook-store.js';

const READ2: PlaybookBlock[] = [
  { id: 'b1', type: 'tool', toolId: 'sangfor.advisor_fortios_advanced', deviceId: 'dev_1' },
  { id: 'r1', type: 'report', title: '종합 리포트' },
];

describe('PlaybookStore — CRUD·검증·상태기계 (T-PB-1)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pb-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('create → rev 1 draft, get/list 왕복, 재로드 생존', () => {
    const store = new PlaybookStore(dir);
    const pb = store.create({ name: '자문 루프', goal: '전체분석→보고서', blocks: READ2, authoredBy: 'agent:claude', note: '조립근거' });
    expect(pb.id).toMatch(/^pb_/);
    expect(pb.revisions).toHaveLength(1);
    expect(pb.revisions[0]).toMatchObject({ rev: 1, status: 'draft', authoredBy: 'agent:claude', note: '조립근거' });
    expect(store.get(pb.id)!.name).toBe('자문 루프');
    expect(new PlaybookStore(dir).get(pb.id)).toBeDefined(); // atomic write 후 재로드
    expect(store.activeRevision(pb)).toBeUndefined(); // 아직 승인본 없음
  });

  it('블록 검증 fail-closed: 빈 blocks / 중복 id / tool에 toolId 없음 / report에 args / report 2개', () => {
    const store = new PlaybookStore(dir);
    const base = { name: 'x', goal: 'g', authoredBy: 'a' };
    expect(() => store.create({ ...base, blocks: [] })).toThrow(PlaybookValidationError);
    expect(() => store.create({ ...base, blocks: [{ id: 'b1', type: 'tool', toolId: 't' }, { id: 'b1', type: 'tool', toolId: 't' }] })).toThrow(/중복/);
    expect(() => store.create({ ...base, blocks: [{ id: 'b1', type: 'tool' }] })).toThrow(/toolId/);
    expect(() => store.create({ ...base, blocks: [{ id: 'b1', type: 'report', args: { x: 1 } }] })).toThrow(/report/);
    expect(() => store.create({ ...base, blocks: [{ id: 'r1', type: 'report' }, { id: 'r2', type: 'report' }] })).toThrow(/report 블록은 최대 1개/);
  });

  it('저장 전 maskSecrets: 블록 args의 비밀 키는 *** (§7.5)', () => {
    const store = new PlaybookStore(dir);
    const pb = store.create({ name: 'x', goal: 'g', authoredBy: 'a', blocks: [
      { id: 'b1', type: 'tool', toolId: 't', args: { host: 'h', password: 'hunter2', nested: { token: 'x' } } },
    ] });
    const args = pb.revisions[0].blocks[0].args as Record<string, unknown>;
    expect(args.password).toBe('***');
    expect((args.nested as Record<string, unknown>).token).toBe('***');
    expect(args.host).toBe('h'); // 비밀 아닌 키는 보존 → 템플릿도 보존
  });

  it('addRevision → rev N+1 draft, 상태기계: 승인/반려', () => {
    const store = new PlaybookStore(dir);
    const pb = store.create({ name: 'x', goal: 'g', authoredBy: 'a', blocks: READ2 });
    const r2 = store.addRevision(pb.id, { blocks: READ2, authoredBy: 'agent:claude', note: '피드백 반영' });
    expect(r2.revisions).toHaveLength(2);
    expect(r2.revisions[1].rev).toBe(2);
    // 반려는 사유 필수
    expect(() => store.reviewRevision(pb.id, 2, { approve: false, reviewedBy: 'jmpark' })).toThrow(/사유/);
    const rejected = store.reviewRevision(pb.id, 2, { approve: false, reviewedBy: 'jmpark', rejectReason: 'HA 누락' });
    expect(rejected.revisions[1].status).toBe('rejected');
    expect(rejected.revisions[1].rejectReason).toBe('HA 누락');
    // rev 1 승인 → activeRevision
    const approved = store.reviewRevision(pb.id, 1, { approve: true, reviewedBy: 'jmpark' });
    expect(store.activeRevision(approved)!.rev).toBe(1);
    // draft 아닌 리비전 재심사 → 409
    expect(() => store.reviewRevision(pb.id, 1, { approve: true, reviewedBy: 'x' }))
      .toThrow(expect.objectContaining({ status: 409 }));
  });

  it('activeRevision = approved 중 최대 rev', () => {
    const store = new PlaybookStore(dir);
    const pb = store.create({ name: 'x', goal: 'g', authoredBy: 'a', blocks: READ2 });
    store.addRevision(pb.id, { blocks: READ2, authoredBy: 'a' });
    store.reviewRevision(pb.id, 1, { approve: true, reviewedBy: 'j' });
    const p2 = store.reviewRevision(pb.id, 2, { approve: true, reviewedBy: 'j' });
    expect(store.activeRevision(p2)!.rev).toBe(2);
  });
});
