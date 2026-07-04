import { describe, expect, it } from 'vitest';
import { resolveTemplates, derivePlaybookRunStatus, renderReport, TemplateError } from '../apps/control-tower/src/playbook-engine.js';
import type { RunRecord } from '@sangfor/runs';
import type { Playbook, PlaybookRevision } from '../apps/control-tower/src/playbook-store.js';

function run(over: Partial<RunRecord>): RunRecord {
  return {
    schemaVersion: 1, runId: over.runId ?? 'run_x', toolId: 't', toolSafety: 'read_only',
    args: {}, status: 'succeeded', requestedAt: '2026-07-04T00:00:00.000Z', ...over,
  };
}

describe('resolveTemplates (T-PB-3)', () => {
  const lookup = (id: string) => id === 'b1'
    ? run({ runId: 'run_b1', blockId: 'b1', resultJson: { host: '10.0.0.1', summary: { pass: 3 }, list: [1, 2] } })
    : undefined;

  it('정확히 템플릿 하나 → 해석값(타입 보존), 부분 포함 → String 보간', () => {
    expect(resolveTemplates({ h: '{{blocks.b1.result.host}}' }, lookup)).toEqual({ h: '10.0.0.1' });
    expect(resolveTemplates({ n: '{{blocks.b1.result.summary.pass}}' }, lookup)).toEqual({ n: 3 }); // number 보존
    expect(resolveTemplates({ arr: '{{blocks.b1.result.list}}' }, lookup)).toEqual({ arr: [1, 2] }); // array 보존
    expect(resolveTemplates({ msg: 'host=({{blocks.b1.result.host}})' }, lookup)).toEqual({ msg: 'host=(10.0.0.1)' });
    expect(resolveTemplates({ deep: { x: '{{blocks.b1.result.host}}' }, plain: 5 }, lookup))
      .toEqual({ deep: { x: '10.0.0.1' }, plain: 5 });
  });

  it('블록 미완료/경로 없음 → TemplateError (해석 실패는 값이 아니라 예외)', () => {
    expect(() => resolveTemplates({ x: '{{blocks.b2.result.host}}' }, lookup)).toThrow(TemplateError);
    expect(() => resolveTemplates({ x: '{{blocks.b1.result.nope.deep}}' }, lookup)).toThrow(TemplateError);
    const pending = (id: string) => run({ runId: 'p', blockId: id, status: 'pending_approval', resultJson: undefined });
    expect(() => resolveTemplates({ x: '{{blocks.b1.result.host}}' }, pending)).toThrow(TemplateError);
  });
});

function rev(blocks: PlaybookRevision['blocks']): PlaybookRevision {
  return { rev: 1, blocks, authoredBy: 'a', status: 'approved', createdAt: '2026-07-04T00:00:00.000Z' };
}
const R = rev([
  { id: 'b1', type: 'tool', toolId: 't1' },
  { id: 'b2', type: 'tool', toolId: 't2' },
  { id: 'r1', type: 'report' },
]);

describe('derivePlaybookRunStatus (T-PB-3)', () => {
  it('pending 있으면 waiting_approval', () => {
    const runs = [run({ blockId: 'b1', status: 'succeeded' }), run({ blockId: 'b2', status: 'pending_approval' })];
    expect(derivePlaybookRunStatus(R, runs).status).toBe('waiting_approval');
  });
  it('실행 없는 블록 남음(실패 없음) → running', () => {
    expect(derivePlaybookRunStatus(R, [run({ blockId: 'b1', status: 'succeeded' })]).status).toBe('running');
  });
  it('모든 블록 succeeded → succeeded', () => {
    const runs = [run({ blockId: 'b1' }), run({ blockId: 'b2' }), run({ blockId: 'r1' })];
    expect(derivePlaybookRunStatus(R, runs).status).toBe('succeeded');
  });
  it('실패 + report succeeded → partial', () => {
    const runs = [run({ blockId: 'b1', status: 'failed' }), run({ blockId: 'r1', status: 'succeeded' })];
    expect(derivePlaybookRunStatus(R, runs).status).toBe('partial');
  });
  it('실패 + report 없음/미실행 → failed, blocks 매핑 반환', () => {
    const runs = [run({ runId: 'run_b1', blockId: 'b1', status: 'failed' })];
    const out = derivePlaybookRunStatus(R, runs);
    expect(out.status).toBe('failed');
    expect(out.blocks).toEqual([
      { blockId: 'b1', runId: 'run_b1', status: 'failed' },
      { blockId: 'b2', runId: undefined, status: undefined },
      { blockId: 'r1', runId: undefined, status: undefined },
    ]);
  });
  it('실행 중 블록 있음 → running (failed 있어도 우선)', () => {
    const runs = [run({ blockId: 'b1', status: 'running' })];
    expect(derivePlaybookRunStatus(R, runs).status).toBe('running');
    // running이 failed보다 먼저 체크되는지 검증
    const runsWithFailed = [run({ blockId: 'b1', status: 'failed' }), run({ blockId: 'b2', status: 'running' })];
    expect(derivePlaybookRunStatus(R, runsWithFailed).status).toBe('running');
  });
  it('거절 + report 미실행 → failed; report 성공 → partial', () => {
    const runs = [run({ blockId: 'b1', status: 'rejected' })];
    expect(derivePlaybookRunStatus(R, runs).status).toBe('failed');
    const runsWithReportSucceeded = [run({ blockId: 'b1', status: 'rejected' }), run({ blockId: 'r1', status: 'succeeded' })];
    expect(derivePlaybookRunStatus(R, runsWithReportSucceeded).status).toBe('partial');
  });
});

describe('renderReport (T-PB-3)', () => {
  const pb: Playbook = {
    id: 'pb_1', name: '자문 루프', goal: '전체분석', createdAt: '', updatedAt: '',
    revisions: [rev([
      { id: 'b1', type: 'tool', toolId: 'sangfor.advisor_fortios', title: 'FortiOS 자문' },
      { id: 'r1', type: 'report' },
    ])],
  };
  const blockRuns = [run({
    runId: 'run_b1', blockId: 'b1', status: 'succeeded', resultSummary: 'ok=false pass=1 fail=1',
    resultJson: { evaluation: { specId: 's', ok: false, summary: { pass: 1, fail: 1 }, items: [
      { id: 'i1', label: 'HA 설정', verdict: 'FAIL', category: 'missing', observed: 'off', expected: 'on', reason: 'HA 비활성' },
      { id: 'i2', label: '펌웨어', verdict: 'PASS', category: 'ok', reason: 'ok' },
    ] } },
  })];

  it('FAIL 항목 취합 + 결정성(같은 입력=같은 출력) + 기계집계 고지', () => {
    const md = renderReport(pb, 1, 'pbrun_1', blockRuns);
    expect(md).toContain('자문 루프');
    expect(md).toContain('FortiOS 자문');
    expect(md).toContain('HA 설정');       // FAIL 항목 표
    expect(md).toContain('HA 비활성');       // reason
    expect(md).not.toContain('펌웨어');      // PASS 항목은 표에 없음
    expect(md).toContain('기계 집계');       // AI 분석과 구분 고지
    expect(renderReport(pb, 1, 'pbrun_1', blockRuns)).toBe(md); // 결정적
  });
});

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, afterEach } from 'vitest';
import { createApi } from '../apps/control-tower/src/api.js';
import { PlaybookStore } from '../apps/control-tower/src/playbook-store.js';

// read: EvaluationResult 반환 / write: pending 대상 / fail: isError
const ENGINE_TOOLS = {
  tools: [
    { name: 'eng.read', description: 'r', inputSchema: { type: 'object', properties: { host: { type: 'string' } } }, annotations: { title: 'r', readOnlyHint: true, destructiveHint: false }, category: 'advisory' },
    { name: 'eng.write', description: 'w', inputSchema: { type: 'object', properties: { customer: { type: 'string' } }, required: ['customer'] }, annotations: { title: 'w', readOnlyHint: false, destructiveHint: false }, category: 'pm' },
    { name: 'eng.fail', description: 'f', inputSchema: { type: 'object', properties: {} }, annotations: { title: 'f', readOnlyHint: true, destructiveHint: false }, category: 'advisory' },
  ],
};

describe('플레이북 실행 엔진 (T-PB-4)', () => {
  let bridge: http.Server; let bridgeUrl: string;
  let runsDir: string; let registryDir: string; let outDir: string;

  function startBridge(): Promise<void> {
    bridge = http.createServer(async (req, res) => {
      const send = (s: number, b: unknown) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
      if (req.method === 'GET' && req.url === '/health') return send(200, { status: 'ok', mcp: 'connected' });
      if (req.method === 'GET' && req.url === '/tools') return send(200, ENGINE_TOOLS);
      if (req.method === 'POST' && req.url === '/tools/call') {
        const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (body.name === 'eng.fail') return send(200, { result: { content: [{ type: 'text', text: 'boom' }], isError: true } });
        const payload = body.name === 'eng.read'
          ? { evaluation: { specId: 's', ok: true, items: [], summary: { pass: 2, fail: 0 }, coverage: {} } }
          : { created: true, echo: body.arguments };
        return send(200, { result: { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload, isError: false } });
      }
      send(404, { error: 'nf' });
    });
    return new Promise((r) => bridge.listen(0, '127.0.0.1', () => { bridgeUrl = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`; r(); }));
  }

  const mkApi = () => createApi({ bridgeUrl, runsDir, registryDir, playbookOutputDir: outDir, approvalSecret: 'sec', mockConsoleUrl: 'http://127.0.0.1:1' });

  beforeEach(async () => {
    runsDir = mkdtempSync(join(tmpdir(), 'eng-runs-'));
    registryDir = mkdtempSync(join(tmpdir(), 'eng-reg-'));
    outDir = mkdtempSync(join(tmpdir(), 'eng-out-'));
    await startBridge();
  });
  afterEach(async () => {
    await new Promise<void>((r) => bridge.close(() => r()));
    for (const d of [runsDir, registryDir, outDir]) rmSync(d, { recursive: true, force: true });
  });

  function seedApproved(blocks: import('../apps/control-tower/src/playbook-store.js').PlaybookBlock[]): string {
    const store = new PlaybookStore(registryDir);
    const pb = store.create({ name: 'p', goal: 'g', authoredBy: 'a', blocks });
    store.reviewRevision(pb.id, 1, { approve: true, reviewedBy: 'jmpark' });
    return pb.id;
  }

  it('read 체인 + report → succeeded, report md 파일 생성', async () => {
    const api = mkApi();
    const id = seedApproved([
      { id: 'b1', type: 'tool', toolId: 'eng.read', args: { host: 'h1' } },
      { id: 'b2', type: 'tool', toolId: 'eng.read', args: { host: '{{blocks.b1.result.evaluation.specId}}' } }, // 템플릿 해석
      { id: 'r1', type: 'report' },
    ]);
    const out = await api.executePlaybook(id);
    expect(out.status).toBe('succeeded');
    const md = readFileSync(join(outDir, `${out.playbookRunId}.md`), 'utf8');
    expect(md).toContain('기계 집계');
    // b2가 b1 결과(specId 's')를 host로 받아 실행됨
    const runs = api.listRuns({ playbookRunId: out.playbookRunId });
    expect(runs.filter((r) => r.status === 'succeeded').length).toBe(3); // b1, b2, report
  });

  it('read 실패 → 이후 tool 건너뛰고 report만 실행 → partial', async () => {
    const api = mkApi();
    const id = seedApproved([
      { id: 'b1', type: 'tool', toolId: 'eng.fail' },
      { id: 'b2', type: 'tool', toolId: 'eng.read', args: { host: 'x' } },
      { id: 'r1', type: 'report' },
    ]);
    const out = await api.executePlaybook(id);
    expect(out.status).toBe('partial');
    const runs = api.listRuns({ playbookRunId: out.playbookRunId });
    expect(runs.find((r) => r.blockId === 'b1')!.status).toBe('failed');
    expect(runs.find((r) => r.blockId === 'b2')).toBeUndefined(); // 건너뜀
    expect(runs.find((r) => r.blockId === 'r1')!.status).toBe('succeeded'); // 부분 리포트
  });

  it('write 블록 도달 → pending_approval + 엔진 정지 (waiting_approval), report 미실행', async () => {
    const api = mkApi();
    const id = seedApproved([
      { id: 'b1', type: 'tool', toolId: 'eng.read', args: { host: 'h' } },
      { id: 'b2', type: 'tool', toolId: 'eng.write', args: { customer: 'acme' } },
      { id: 'r1', type: 'report' },
    ]);
    const out = await api.executePlaybook(id);
    expect(out.status).toBe('waiting_approval');
    const runs = api.listRuns({ playbookRunId: out.playbookRunId });
    expect(runs.find((r) => r.blockId === 'b2')!.status).toBe('pending_approval');
    expect(runs.find((r) => r.blockId === 'r1')).toBeUndefined(); // 아직 리포트 없음
  });

  it('write 승인 → continueRun으로 후속 report까지 → succeeded', async () => {
    const api = mkApi();
    const id = seedApproved([
      { id: 'b1', type: 'tool', toolId: 'eng.write', args: { customer: 'acme' } },
      { id: 'r1', type: 'report' },
    ]);
    const started = await api.executePlaybook(id);
    expect(started.status).toBe('waiting_approval');
    const pending = api.listRuns({ playbookRunId: started.playbookRunId }).find((r) => r.blockId === 'b1')!;
    await api.approveRun(pending.runId, { approvedBy: 'jmpark' });
    const derived = api.getPlaybookRun(started.playbookRunId);
    expect(derived.status).toBe('succeeded'); // 승인 후 report까지 이어짐
  });

  it('활성 리비전 없이 execute → 403', async () => {
    const api = mkApi();
    const store = new PlaybookStore(registryDir);
    const pb = store.create({ name: 'p', goal: 'g', authoredBy: 'a', blocks: [{ id: 'b1', type: 'tool', toolId: 'eng.read' }] });
    await expect(api.executePlaybook(pb.id)).rejects.toMatchObject({ status: 403 });
  });
});
