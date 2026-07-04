import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTowerServer } from '../apps/control-tower/src/server.js';
import { Registry, type VendorDescriptor } from '../apps/control-tower/src/registry.js';
import type { RunRecord } from '@sangfor/runs';

// ─── stub bridge ────────────────────────────────────────────────────────────
const STUB_TOOLS = {
  tools: [
    {
      name: 'stub.read', description: 'echo read',
      inputSchema: {
        type: 'object',
        properties: { host: { type: 'string' }, username: { type: 'string' }, password: { type: 'string' }, specVersion: { type: 'string', default: '1.0' } },
        required: ['host', 'username', 'password'],
      },
      annotations: { title: 'stub read', readOnlyHint: true, destructiveHint: false }, category: 'advisory',
    },
    {
      name: 'stub.write', description: 'echo write',
      inputSchema: { type: 'object', properties: { customer: { type: 'string' }, password: { type: 'string' } }, required: ['customer'] },
      annotations: { title: 'stub write', readOnlyHint: false, destructiveHint: false }, category: 'pm',
    },
    {
      name: 'stub.fail', description: 'always isError',
      inputSchema: { type: 'object', properties: {} },
      annotations: { title: 'stub fail', readOnlyHint: true, destructiveHint: false }, category: 'admin',
    },
  ],
};

let stubBridge: http.Server;
let bridgeUrl: string;
let lastCall: { name: string; arguments: Record<string, unknown>; approval?: Record<string, unknown> } | null;

function startStubBridge(): Promise<void> {
  stubBridge = http.createServer(async (req, res) => {
    const respond = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/health') return respond(200, { status: 'ok', mcp: 'connected' });
    if (req.method === 'GET' && req.url === '/tools') return respond(200, STUB_TOOLS);
    if (req.method === 'POST' && req.url === '/tools/call') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      lastCall = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      // 실제 bridge처럼 목록에 없는 도구는 403 — Task 8 health 테스트의 store/rag 프로브가 이 경로를 탄다
      if (!STUB_TOOLS.tools.some((t) => t.name === lastCall!.name)) {
        return respond(403, { error: 'Tool annotations unavailable; refusing call: ' + lastCall!.name });
      }
      if (lastCall!.name === 'stub.fail') {
        return respond(200, { result: { content: [{ type: 'text', text: 'stub tool exploded: ' + JSON.stringify(lastCall!.arguments) }], isError: true } });
      }
      const payload = lastCall!.name === 'stub.read'
        ? { evaluation: { specId: 's', ok: true, items: [], summary: { pass: 3, fail: 0, indeterminate: 0 }, coverage: {} } }
        : { created: true, echo: lastCall!.arguments, note: 'ran with password ' + String((lastCall!.arguments as Record<string, unknown>).password ?? '') };
      return respond(200, { result: { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload, isError: false } });
    }
    respond(404, { error: 'not found' });
  });
  return new Promise((r) => stubBridge.listen(0, '127.0.0.1', () => {
    bridgeUrl = `http://127.0.0.1:${(stubBridge.address() as AddressInfo).port}`;
    r();
  }));
}

// ─── tower 기동 헬퍼 ────────────────────────────────────────────────────────
let runsDir: string;
let registryDir: string;
let tower: http.Server;
let towerUrl: string;

function startTower(opts: Record<string, unknown> = {}): Promise<http.Server> {
  const server = createTowerServer({
    bridgeUrl, runsDir, registryDir,
    approvalSecret: 'api-secret', apiToken: 'test-token',
    mockConsoleUrl: 'http://127.0.0.1:1',
    ...opts,
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

const urlOf = (server: http.Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function call(method: string, path: string, body?: unknown, base?: string, token = 'test-token') {
  const res = await fetch(`${base ?? towerUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

beforeEach(async () => {
  runsDir = mkdtempSync(join(tmpdir(), 'tower-runs-'));
  registryDir = mkdtempSync(join(tmpdir(), 'tower-reg-'));
  lastCall = null;
  await startStubBridge();
  tower = await startTower();
  towerUrl = urlOf(tower);
});

afterEach(async () => {
  await new Promise<void>((r) => tower.close(() => r()));
  await new Promise<void>((r) => stubBridge.close(() => r()));
  rmSync(runsDir, { recursive: true, force: true });
  rmSync(registryDir, { recursive: true, force: true });
});

describe('Tower API — 인증/검증 (T-API-1)', () => {
  it('토큰 없으면 /api/*는 401, 잘못된 토큰도 401', async () => {
    expect((await call('GET', '/api/runs', undefined, towerUrl, '')).status).toBe(401);
    expect((await call('GET', '/api/runs', undefined, towerUrl, 'wrong')).status).toBe(401);
  });

  it('존재하지 않는 toolId → 400', async () => {
    const r = await call('POST', '/api/runs', { toolId: 'nope.tool', args: {} });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/unknown tool/);
  });
});

describe('Tower API — 읽기전용 즉시 실행 (T-API-1)', () => {
  it('실행→succeeded 레코드 반환, 이력 목록은 resultJson 제외·상세는 포함', async () => {
    const r = await call('POST', '/api/runs', { toolId: 'stub.read', args: { host: 'h', username: 'u', password: 'p' } });
    expect(r.status).toBe(200);
    const run = r.body as unknown as RunRecord;
    expect(run.status).toBe('succeeded');
    expect(run.toolSafety).toBe('read_only');
    expect(run.resultSummary).toBe('ok=true pass=3 fail=0');
    expect(run.args.password).toBe('***'); // 저장소 마스킹 불변식이 응답에도 반영
    expect(lastCall!.arguments.password).toBe('p'); // 실행에는 원본이 나감

    const list = await call('GET', '/api/runs');
    const listed = (list.body.runs as RunRecord[]).find((x) => x.runId === run.runId)!;
    expect(listed).toBeDefined();
    expect('resultJson' in listed).toBe(false);

    const detail = await call('GET', `/api/runs/${run.runId}`);
    expect((detail.body as unknown as RunRecord).resultJson).toBeDefined();
    expect((await call('GET', '/api/runs/run_none')).status).toBe(404);
  });

  it('isError 도구 → failed + error 기록', async () => {
    const r = await call('POST', '/api/runs', { toolId: 'stub.fail', args: { password: 'boom' } });
    const run = r.body as unknown as RunRecord;
    expect(run.status).toBe('failed');
    expect(String(run.error)).toContain('stub tool exploded');
    expect(String(run.error)).toContain('***');
    expect(String(run.error)).not.toContain('boom');
  });

  it('deviceId 지정 시 §5.4 병합 규칙으로 인자 구성 (사용자입력 > mock 폴백)', async () => {
    writeFileSync(join(registryDir, 'vendors.json'), JSON.stringify([{
      product: 'STUB_FW', label: 'Stub FW',
      advisorTools: ['stub.read'], credentialFields: ['host', 'username', 'password'],
      defaultArgs: { specVersion: '1.0' },
    } satisfies VendorDescriptor]));
    const device = new Registry(registryDir).createDevice({ name: 's1', product: 'STUB_FW', host: 'http://127.0.0.1:9', tags: [] });
    const r = await call('POST', '/api/runs', { toolId: 'stub.read', deviceId: device.id, args: { specVersion: '9.9' } });
    expect((r.body as unknown as RunRecord).deviceId).toBe(device.id);
    expect(lastCall!.arguments).toEqual({
      specVersion: '9.9',              // 사용자입력이 defaultArgs를 덮음
      host: 'http://127.0.0.1:9',      // device.host
      username: 'mock', password: 'mock', // required credentialField 폴백
    });
    expect((await call('POST', '/api/runs', { toolId: 'stub.read', deviceId: 'dev_none' })).status).toBe(400);
  });
});

describe('Tower API — 승인 플로우 (T-API-1)', () => {
  it('write → pending_approval(실행 안 함) → approve → 민팅·실행·succeeded + approval 메타', async () => {
    const created = await call('POST', '/api/runs', { toolId: 'stub.write', args: { customer: 'acme', password: 'hunter2' } });
    const pending = created.body as unknown as RunRecord;
    expect(pending.status).toBe('pending_approval');
    expect(lastCall).toBeNull(); // 아직 bridge 호출 없음
    expect((await call('GET', '/api/runs?status=pending_approval')).body.runs).toHaveLength(1);

    const approved = await call('POST', `/api/runs/${pending.runId}/approve`, { approvedBy: 'jmpark' });
    const final = approved.body as unknown as RunRecord;
    expect(final.status).toBe('succeeded');
    expect(final.approval).toMatchObject({ approvedBy: 'jmpark', changeTicketId: `run:${pending.runId}`, rollbackPlanId: 'n/a-read-back-verify' });
    expect(JSON.stringify(final)).not.toMatch(/approvalToken|nonce/); // 토큰·nonce 무저장
    expect(String(final.resultSummary)).toContain('***');      // 요약도 마스킹본 기준
    expect(String(final.resultSummary)).not.toContain('hunter2');  // 비밀값 요약 유출 금지
    expect(lastCall!.name).toBe('stub.write');
    expect(lastCall!.arguments.password).toBe('hunter2'); // 원본 args로 실행 (마스킹본 아님)
    expect(lastCall!.approval).toMatchObject({ approvedBy: 'jmpark' });
    expect(typeof lastCall!.approval!.approvalToken).toBe('string');

    // 이미 최종 상태 → 재승인 409
    expect((await call('POST', `/api/runs/${pending.runId}/approve`, { approvedBy: 'x' })).status).toBe(409);
  });

  it('reject: 사유 필수, pending → rejected. 404/409 케이스', async () => {
    const created = await call('POST', '/api/runs', { toolId: 'stub.write', args: { customer: 'acme' } });
    const pending = created.body as unknown as RunRecord;
    expect((await call('POST', `/api/runs/${pending.runId}/reject`, {})).status).toBe(400);
    const rejected = await call('POST', `/api/runs/${pending.runId}/reject`, { reason: 'no ticket' });
    expect((rejected.body as unknown as RunRecord).status).toBe('rejected');
    expect((rejected.body as unknown as RunRecord).rejectedReason).toBe('no ticket');
    expect((await call('POST', `/api/runs/${pending.runId}/reject`, { reason: 'again' })).status).toBe(409);
    expect((await call('POST', '/api/runs/run_none/approve', { approvedBy: 'x' })).status).toBe(404);
    expect((await call('POST', '/api/runs/run_none/reject', { reason: 'x' })).status).toBe(404);
  });

  it('시크릿 미설정 → 500 fail-closed, 상태는 pending 유지', async () => {
    const bare = await startTower({ approvalSecret: '' });
    const bareUrl = urlOf(bare);
    try {
      const created = await call('POST', '/api/runs', { toolId: 'stub.write', args: { customer: 'a' } }, bareUrl);
      const pending = created.body as unknown as RunRecord;
      const r = await call('POST', `/api/runs/${pending.runId}/approve`, { approvedBy: 'x' }, bareUrl);
      expect(r.status).toBe(500);
      expect(String(r.body.error)).toMatch(/approval secret not configured/);
      const detail = await call('GET', `/api/runs/${pending.runId}`, undefined, bareUrl);
      expect((detail.body as unknown as RunRecord).status).toBe('pending_approval');
    } finally {
      await new Promise<void>((r) => bare.close(() => r()));
    }
  });

  it('타워 재시작 시 원본 인자 소실 → 승인 400 (마스킹본 실행 사고 방지)', async () => {
    const created = await call('POST', '/api/runs', { toolId: 'stub.write', args: { customer: 'a', password: 's' } });
    const pending = created.body as unknown as RunRecord;
    const restarted = await startTower(); // 같은 runsDir/registryDir, 새 프로세스 상태
    try {
      const r = await call('POST', `/api/runs/${pending.runId}/approve`, { approvedBy: 'x' }, urlOf(restarted));
      expect(r.status).toBe(400);
      expect(String(r.body.error)).toMatch(/원본 인자 소실/);
    } finally {
      await new Promise<void>((r) => restarted.close(() => r()));
    }
  });
});

describe('Tower API — devices/sweep/overview/health (T-API-2)', () => {
  function seedStubVendor() {
    writeFileSync(join(registryDir, 'vendors.json'), JSON.stringify([{
      product: 'STUB_FW', label: 'Stub FW',
      advisorTools: ['stub.read', 'stub.write'], // write가 섞인 오기 케이스 포함
      credentialFields: ['host', 'username', 'password'],
      defaultArgs: { specVersion: '1.0' },
    } satisfies VendorDescriptor]));
  }

  it('devices CRUD 라우트: 등록(미등록 product 400)/수정/삭제, 목록은 vendors 동봉', async () => {
    seedStubVendor();
    const bad = await call('POST', '/api/devices', { name: 'x', product: 'NOPE', host: 'h' });
    expect(bad.status).toBe(400);
    const created = await call('POST', '/api/devices', { name: 'fw1', product: 'STUB_FW', host: 'http://127.0.0.1:9', tags: ['lab'] });
    expect(created.status).toBe(200);
    const id = String((created.body as Record<string, unknown>).id);
    const list = await call('GET', '/api/devices');
    expect((list.body.devices as unknown[])).toHaveLength(1);
    expect((list.body.vendors as Array<{ product: string }>)[0].product).toBe('STUB_FW');
    const updated = await call('PUT', `/api/devices/${id}`, { name: 'fw1-renamed' });
    expect((updated.body as Record<string, unknown>).name).toBe('fw1-renamed');
    expect((await call('DELETE', `/api/devices/${id}`)).body).toEqual({ ok: true });
    expect((await call('PUT', '/api/devices/dev_none', { name: 'x' })).status).toBe(400);
  });

  it('sweep: 장비×advisorTools 실행, read-only 아닌 도구는 failed 기록, sweepId 태깅', async () => {
    seedStubVendor();
    const device = new Registry(registryDir).createDevice({ name: 's1', product: 'STUB_FW', host: 'http://127.0.0.1:9', tags: [] });
    const r = await call('POST', '/api/sweep', {});
    expect(r.status).toBe(200);
    const sweepId = String(r.body.sweepId);
    expect(sweepId).toMatch(/^sweep_/);
    const runs = r.body.runs as RunRecord[];
    expect(runs).toHaveLength(2); // stub.read + stub.write
    const read = runs.find((x) => x.toolId === 'stub.read')!;
    const write = runs.find((x) => x.toolId === 'stub.write')!;
    expect(read.status).toBe('succeeded');
    expect(read.sweepId).toBe(sweepId);
    expect(read.deviceId).toBe(device.id);
    expect(write.status).toBe('failed');
    expect(write.error).toBe('sweep은 읽기전용 도구만 실행');
    // 이력에서 sweepId 필터로 재조회 가능
    const listed = await call('GET', `/api/runs?sweepId=${sweepId}`);
    expect((listed.body.runs as RunRecord[])).toHaveLength(2);
    // 존재하지 않는 deviceIds → 400
    expect((await call('POST', '/api/sweep', { deviceIds: ['dev_none'] })).status).toBe(400);
  });

  it('tools: category 그룹핑', async () => {
    const r = await call('GET', '/api/tools');
    const groups = r.body.groups as Record<string, Array<{ name: string }>>;
    expect(groups.advisory.map((t) => t.name)).toContain('stub.read');
    expect(groups.pm.map((t) => t.name)).toContain('stub.write');
  });

  it('overview: 4위젯 형태 + 장비 요약의 lastAdvisory 파싱 + 목록 resultJson 제외', async () => {
    seedStubVendor();
    const device = new Registry(registryDir).createDevice({ name: 's1', product: 'STUB_FW', host: 'http://127.0.0.1:9', tags: [] });
    await call('POST', '/api/runs', { toolId: 'stub.read', deviceId: device.id });   // 자문 성공 이력
    await call('POST', '/api/runs', { toolId: 'stub.write', args: { customer: 'a' } }); // 승인 대기 1건
    const r = await call('GET', '/api/overview');
    expect(r.status).toBe(200);
    const body = r.body as {
      devices: Array<{ id: string; productLabel: string; lastAdvisory?: { ok?: boolean; pass?: number; fail?: number } }>;
      recentRuns: RunRecord[];
      pendingApprovals: RunRecord[];
      health: Record<string, { ok: boolean; detail: string }>;
    };
    expect(body.devices[0].productLabel).toBe('Stub FW');
    expect(body.devices[0].lastAdvisory).toMatchObject({ ok: true, pass: 3, fail: 0 });
    expect(body.recentRuns.length).toBeGreaterThanOrEqual(2);
    expect(body.recentRuns.every((x) => !('resultJson' in x))).toBe(true);
    expect(body.pendingApprovals).toHaveLength(1);
    expect(body.health.bridge.ok).toBe(true);
    expect(body.health.mcp.ok).toBe(true);
    expect(body.health.mockConsole.ok).toBe(false); // mockConsoleUrl이 죽은 포트
  });

  it('health: 부분 실패를 값으로 표현 (stub bridge에는 store/rag 도구가 없음 → ok:false)', async () => {
    const r = await call('GET', '/api/health');
    const health = r.body as Record<string, { ok: boolean; detail: string }>;
    expect(health.bridge.ok).toBe(true);
    expect(health.store.ok).toBe(false); // stub bridge가 sangfor.store_health를 모름 → 404/error
    expect(health.rag.ok).toBe(false);
    expect(health.mockConsole.ok).toBe(false);
  });

  it('mint 라우트: 시크릿 있으면 SignedApproval 반환, 필수 필드 누락 400', async () => {
    const r = await call('POST', '/api/approvals/mint', {
      actionType: 'hci.create-volume', actionTarget: '127.0.0.1:vol-a',
      approvedBy: 'jmpark', changeTicketId: 'CHG-1', rollbackPlanId: 'RB-1', ttlSec: 60,
    });
    expect(r.status).toBe(200);
    expect(typeof r.body.approvalToken).toBe('string');
    expect(typeof r.body.nonce).toBe('string');
    expect((await call('POST', '/api/approvals/mint', { actionType: 'x' })).status).toBe(400);
  });

  it('mint: 시크릿 미설정 시 500 fail-closed', async () => {
    const bare = await startTower({ approvalSecret: '' });
    try {
      const r = await call('POST', '/api/approvals/mint', {
        actionType: 'hci.create-volume', actionTarget: 'h:vol',
        approvedBy: 'jmpark', changeTicketId: 'CHG-1', rollbackPlanId: 'RB-1',
      }, urlOf(bare));
      expect(r.status).toBe(500);
      expect(String(r.body.error)).toMatch(/approval secret not configured/);
    } finally {
      await new Promise<void>((res) => bare.close(() => res()));
    }
  });

  it('sweep: promisePool이 동시 실행을 3으로 제한한다', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const READONLY_TOOLS = Array.from({ length: 9 }, (_, i) => `stub.ro${i}`);
    const countingBridge = http.createServer(async (req, res) => {
      const respond = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.method === 'GET' && req.url === '/health') return respond(200, { status: 'ok', mcp: 'connected' });
      if (req.method === 'GET' && req.url === '/tools') {
        return respond(200, { tools: READONLY_TOOLS.map((name) => ({
          name, description: 'ro', inputSchema: { type: 'object', properties: {} },
          annotations: { title: name, readOnlyHint: true, destructiveHint: false }, category: 'advisory',
        })) });
      }
      if (req.method === 'POST' && req.url === '/tools/call') {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 25));
        inFlight -= 1;
        return respond(200, { result: { content: [{ type: 'text', text: '{"ok":true}' }], structuredContent: { ok: true }, isError: false } });
      }
      respond(404, { error: 'not found' });
    });
    await new Promise<void>((r) => countingBridge.listen(0, '127.0.0.1', () => r()));
    const cbUrl = `http://127.0.0.1:${(countingBridge.address() as AddressInfo).port}`;
    const cRunsDir = mkdtempSync(join(tmpdir(), 'sweep-runs-'));
    const cRegDir = mkdtempSync(join(tmpdir(), 'sweep-reg-'));
    writeFileSync(join(cRegDir, 'vendors.json'), JSON.stringify([{
      product: 'MANY_FW', label: 'Many', advisorTools: READONLY_TOOLS,
      credentialFields: [], defaultArgs: {},
    }]));
    new Registry(cRegDir).createDevice({ name: 'm1', product: 'MANY_FW', host: 'http://127.0.0.1:9', tags: [] });
    const cTower = createTowerServer({ bridgeUrl: cbUrl, runsDir: cRunsDir, registryDir: cRegDir, approvalSecret: 's', apiToken: 'test-token', mockConsoleUrl: 'http://127.0.0.1:1' });
    await new Promise<void>((r) => cTower.listen(0, '127.0.0.1', () => r()));
    try {
      const r = await call('POST', '/api/sweep', {}, urlOf(cTower));
      expect(r.status).toBe(200);
      expect((r.body.runs as unknown[]).length).toBe(9);
      expect(maxInFlight).toBeGreaterThan(1);   // 실제로 병렬 실행됨
      expect(maxInFlight).toBeLessThanOrEqual(3); // 그러나 3을 넘지 않음
    } finally {
      await new Promise<void>((res) => cTower.close(() => res()));
      await new Promise<void>((res) => countingBridge.close(() => res()));
      rmSync(cRunsDir, { recursive: true, force: true });
      rmSync(cRegDir, { recursive: true, force: true });
    }
  });
});

describe('Tower UI 서빙', () => {
  it('GET /는 무인증 HTML(한국어 레이블 포함), /api/*만 토큰 게이트', async () => {
    const res = await fetch(`${towerUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain('Sangfor Control Tower');
    expect(html).toContain('대시보드');
    expect(html).toContain('도구 실행');
    expect(html).toContain('실행 이력');
    expect(html).toContain('장비 관리');
  });
});
