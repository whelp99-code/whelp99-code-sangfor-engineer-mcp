import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTowerServer } from '../apps/control-tower/src/server.js';

const TOOLS = { tools: [
  { name: 'p.read', description: 'r', inputSchema: { type: 'object', properties: { host: { type: 'string' } } }, annotations: { title: 'r', readOnlyHint: true, destructiveHint: false }, category: 'advisory' },
  { name: 'p.write', description: 'w', inputSchema: { type: 'object', properties: { customer: { type: 'string' } }, required: ['customer'] }, annotations: { title: 'w', readOnlyHint: false, destructiveHint: false }, category: 'pm' },
] };

let bridge: http.Server, bridgeUrl: string, runsDir: string, registryDir: string, outDir: string, tower: http.Server, towerUrl: string;

function startBridge(): Promise<void> {
  bridge = http.createServer(async (req, res) => {
    const send = (s: number, b: unknown) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (req.method === 'GET' && req.url === '/health') return send(200, { status: 'ok', mcp: 'connected' });
    if (req.method === 'GET' && req.url === '/tools') return send(200, TOOLS);
    if (req.method === 'POST' && req.url === '/tools/call') {
      const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const payload = body.name === 'p.read'
        ? { evaluation: { specId: 's', ok: true, items: [], summary: { pass: 1, fail: 0 }, coverage: {} } }
        : { created: true };
      return send(200, { result: { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload, isError: false } });
    }
    send(404, { error: 'nf' });
  });
  return new Promise((r) => bridge.listen(0, '127.0.0.1', () => { bridgeUrl = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`; r(); }));
}
const urlOf = (s: http.Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
async function call(method: string, path: string, body?: unknown, base?: string, token = 'test-token') {
  const res = await fetch(`${base ?? towerUrl}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}
function startTower(): Promise<http.Server> {
  const s = createTowerServer({ bridgeUrl, runsDir, registryDir, playbookOutputDir: outDir, approvalSecret: 'sec', apiToken: 'test-token', mockConsoleUrl: 'http://127.0.0.1:1' });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s)));
}

beforeEach(async () => {
  runsDir = mkdtempSync(join(tmpdir(), 'pbapi-runs-'));
  registryDir = mkdtempSync(join(tmpdir(), 'pbapi-reg-'));
  outDir = mkdtempSync(join(tmpdir(), 'pbapi-out-'));
  await startBridge();
  tower = await startTower();
  towerUrl = urlOf(tower);
});
afterEach(async () => {
  await new Promise<void>((r) => tower.close(() => r()));
  await new Promise<void>((r) => bridge.close(() => r()));
  for (const d of [runsDir, registryDir, outDir]) rmSync(d, { recursive: true, force: true });
});

const READ_REPORT = [
  { id: 'b1', type: 'tool', toolId: 'p.read', args: { host: 'h' } },
  { id: 'r1', type: 'report' },
];

describe('Playbook API — 조립·검증·실행 (T-PB-5)', () => {
  it('조립(draft 400 검증) → 승인 → 실행, draft 실행은 403', async () => {
    const bad = await call('POST', '/api/playbooks', { name: 'x', goal: 'g', authoredBy: 'a', blocks: [] });
    expect(bad.status).toBe(400);
    const created = await call('POST', '/api/playbooks', { name: '자문', goal: '전체분석', authoredBy: 'agent:claude', blocks: READ_REPORT });
    expect(created.status).toBe(200);
    const pbId = String((created.body as { id: string }).id);
    // 승인 전 실행 → 403
    expect((await call('POST', `/api/playbooks/${pbId}/execute`, {})).status).toBe(403);
    // 승인
    const approved = await call('POST', `/api/playbooks/${pbId}/revisions/1/approve`, { reviewedBy: 'jmpark' });
    expect(approved.status).toBe(200);
    // 실행 → succeeded
    const run = await call('POST', `/api/playbooks/${pbId}/execute`, {});
    expect(run.status).toBe(200);
    expect(run.body.status).toBe('succeeded');
    const pbrunId = String(run.body.playbookRunId);
    // playbook-run 조회 (유도 상태 + 블록 매핑 + 분석 목록)
    const detail = await call('GET', `/api/playbook-runs/${pbrunId}`);
    expect(detail.body.status).toBe('succeeded');
    expect((detail.body.blocks as unknown[]).length).toBe(2);
    expect(detail.body.analyses).toEqual([]);
    // 블록 run은 일반 이력에도 playbookRunId 필터로 보인다
    const listed = await call('GET', `/api/runs?playbookRunId=${pbrunId}`);
    expect((listed.body.runs as unknown[]).length).toBe(2);
  });

  it('리비전 diff용 데이터 형태: revisions 배열에 blocks·status·rejectReason', async () => {
    const created = await call('POST', '/api/playbooks', { name: 'x', goal: 'g', authoredBy: 'a', blocks: READ_REPORT });
    const pbId = String((created.body as { id: string }).id);
    await call('POST', `/api/playbooks/${pbId}/revisions/1/reject`, { reviewedBy: 'j', reason: 'HA 누락' });
    const r2 = await call('POST', `/api/playbooks/${pbId}/revisions`, { authoredBy: 'agent:claude', note: '반영', blocks: READ_REPORT });
    const pb = r2.body as { revisions: Array<{ rev: number; status: string; rejectReason?: string; blocks: unknown[] }> };
    expect(pb.revisions).toHaveLength(2);
    expect(pb.revisions[0].status).toBe('rejected');
    expect(pb.revisions[0].rejectReason).toBe('HA 누락');
    expect(pb.revisions[1].blocks).toHaveLength(2);
    // reason 없는 reject → 400
    const c2 = await call('POST', '/api/playbooks', { name: 'y', goal: 'g', authoredBy: 'a', blocks: READ_REPORT });
    expect((await call('POST', `/api/playbooks/${String((c2.body as { id: string }).id)}/revisions/1/reject`, { reviewedBy: 'j' })).status).toBe(400);
  });

  it('agent-task 큐 왕복: 생성 → open 폴 → close(결과)', async () => {
    const t = await call('POST', '/api/agent-tasks', { kind: 'assemble', payload: { goal: '전체분석' } });
    const taskId = String((t.body as { id: string }).id);
    expect((await call('GET', '/api/agent-tasks?status=open')).body.tasks).toHaveLength(1);
    const closed = await call('PATCH', `/api/agent-tasks/${taskId}`, { result: { playbookId: 'pb_1', rev: 1 } });
    expect((closed.body as { status: string }).status).toBe('done');
    expect((await call('GET', '/api/agent-tasks?status=open')).body.tasks).toHaveLength(0);
    // cancel 경로
    const t2 = await call('POST', '/api/agent-tasks', { kind: 'analyze', payload: { playbookRunId: 'pbrun_1' } });
    const cancelled = await call('PATCH', `/api/agent-tasks/${String((t2.body as { id: string }).id)}`, { cancel: true });
    expect((cancelled.body as { status: string }).status).toBe('cancelled');
  });

  it('분석 제출 → verdict 채택(제안에 linkedPlaybookId)', async () => {
    // 실행 하나 만들어 playbookRunId 확보
    const created = await call('POST', '/api/playbooks', { name: 'x', goal: 'g', authoredBy: 'a', blocks: READ_REPORT });
    const pbId = String((created.body as { id: string }).id);
    await call('POST', `/api/playbooks/${pbId}/revisions/1/approve`, { reviewedBy: 'j' });
    const run = await call('POST', `/api/playbooks/${pbId}/execute`, {});
    const pbrunId = String(run.body.playbookRunId);
    const submitted = await call('POST', `/api/playbook-runs/${pbrunId}/analysis`, {
      playbookId: pbId, playbookRunId: pbrunId, summary: 'HA 미설정', authoredBy: 'agent:claude',
      improvements: [{ observation: 'HA off', recommendation: 'HA 설정' }],
      proposals: [{ action: 'HA 플레이북', rationale: '가용성' }],
    });
    expect(submitted.status).toBe(200);
    const anlId = String((submitted.body as { id: string }).id);
    const verdict = await call('POST', `/api/analyses/${anlId}/verdict`, { part: 'proposals', index: 0, verdict: 'accepted', reviewedBy: 'jmpark', linkedPlaybookId: 'pb_next' });
    expect((verdict.body as { proposals: Array<{ verdict: string; linkedPlaybookId: string }> }).proposals[0].verdict).toBe('accepted');
    expect((verdict.body as { proposals: Array<{ linkedPlaybookId: string }> }).proposals[0].linkedPlaybookId).toBe('pb_next');
    // 재조회 시 분석이 playbook-run 상세에 붙는다
    expect((await call('GET', `/api/playbook-runs/${pbrunId}`)).body.analyses).toHaveLength(1);
    // 범위 밖 verdict → 400
    expect((await call('POST', `/api/analyses/${anlId}/verdict`, { part: 'improvements', index: 9, verdict: 'accepted', reviewedBy: 'x' })).status).toBe(400);
  });

  it('GET /api/playbooks 목록: activeRev + lastRun 유도상태', async () => {
    const created = await call('POST', '/api/playbooks', { name: 'x', goal: 'g', authoredBy: 'a', blocks: READ_REPORT });
    const pbId = String((created.body as { id: string }).id);
    await call('POST', `/api/playbooks/${pbId}/revisions/1/approve`, { reviewedBy: 'j' });
    await call('POST', `/api/playbooks/${pbId}/execute`, {});
    const list = await call('GET', '/api/playbooks');
    const row = (list.body.playbooks as Array<{ id: string; activeRev?: number; lastRun?: { status: string } }>).find((p) => p.id === pbId)!;
    expect(row.activeRev).toBe(1);
    expect(row.lastRun!.status).toBe('succeeded');
  });
});
