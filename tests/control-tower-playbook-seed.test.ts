import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTowerServer } from '../apps/control-tower/src/server.js';
import { planSeedPlaybooks } from '../apps/control-tower/src/playbook-seed.js';
import { validateBlocks, PlaybookValidationError, type Playbook } from '../apps/control-tower/src/playbook-store.js';
import { SEED_VENDORS, type Device } from '../apps/control-tower/src/registry.js';

const TOOLS = { tools: [
  { name: 'sangfor_store_health', description: 'r', inputSchema: { type: 'object', properties: {} }, annotations: { title: 'r', readOnlyHint: true, destructiveHint: false }, category: 'knowledge' },
  { name: 'sangfor_rag_index_summary', description: 'r', inputSchema: { type: 'object', properties: {} }, annotations: { title: 'r', readOnlyHint: true, destructiveHint: false }, category: 'knowledge' },
  { name: 'sangfor_list_spec_coverage', description: 'r', inputSchema: { type: 'object', properties: {} }, annotations: { title: 'r', readOnlyHint: true, destructiveHint: false }, category: 'advisory' },
] };

let bridge: http.Server, bridgeUrl: string, runsDir: string, registryDir: string, outDir: string, tower: http.Server, towerUrl: string;

function startBridge(): Promise<void> {
  bridge = http.createServer(async (req, res) => {
    const send = (s: number, b: unknown) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (req.method === 'GET' && req.url === '/health') return send(200, { status: 'ok', mcp: 'connected' });
    if (req.method === 'GET' && req.url === '/tools') return send(200, TOOLS);
    if (req.method === 'POST' && req.url === '/tools/call') {
      const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
      JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const payload = { evaluation: { specId: 's', ok: true, items: [], summary: { pass: 1, fail: 0 }, coverage: {} } };
      return send(200, { result: { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload, isError: false } });
    }
    send(404, { error: 'nf' });
  });
  return new Promise((r) => bridge.listen(0, '127.0.0.1', () => { bridgeUrl = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`; r(); }));
}

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${towerUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

function startTower(seedOnStart = false): Promise<http.Server> {
  const s = createTowerServer({
    bridgeUrl, runsDir, registryDir, playbookOutputDir: outDir,
    approvalSecret: 'sec', apiToken: 'test-token', mockConsoleUrl: 'http://127.0.0.1:1',
    seedOnStart,
  });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s)));
}

const DEVICE: Device = {
  id: 'dev_seed_1', name: '스모크 방화벽', product: 'FORTIOS', host: 'http://127.0.0.1:3400',
  tags: ['smoke'], createdAt: '2026-07-30T00:00:00.000Z', updatedAt: '2026-07-30T00:00:00.000Z',
};

beforeEach(async () => {
  runsDir = mkdtempSync(join(tmpdir(), 'pbseed-runs-'));
  registryDir = mkdtempSync(join(tmpdir(), 'pbseed-reg-'));
  outDir = mkdtempSync(join(tmpdir(), 'pbseed-out-'));
  await startBridge();
});
afterEach(async () => {
  if (tower) await new Promise<void>((r) => tower.close(() => r()));
  await new Promise<void>((r) => bridge.close(() => r()));
  for (const d of [runsDir, registryDir, outDir]) rmSync(d, { recursive: true, force: true });
});

describe('planSeedPlaybooks — 순수 후보 생성', () => {
  it('장비가 없으면 타워 자체 점검 1건만, 블록은 전부 검증을 통과한다', () => {
    const out = planSeedPlaybooks([], SEED_VENDORS);
    expect(out.map((c) => c.seedKey)).toEqual(['tower-selfcheck']);
    expect(() => validateBlocks(out[0].blocks)).not.toThrow();
    expect(out[0].blocks.filter((b) => b.type === 'report')).toHaveLength(1);
  });

  it('장비마다 벤더 advisorTools에서 점검 플레이북을 유도한다 (product 하드코딩 없음)', () => {
    const out = planSeedPlaybooks([DEVICE], SEED_VENDORS);
    expect(out.map((c) => c.seedKey)).toEqual(['tower-selfcheck', 'device-checkup:dev_seed_1']);
    const checkup = out[1];
    expect(checkup.blocks.filter((b) => b.type === 'tool').map((b) => b.toolId))
      .toEqual(['sangfor_advisor_fortios', 'sangfor_advisor_fortios_advanced']);
    expect(checkup.blocks.every((b) => b.type === 'report' || b.deviceId === 'dev_seed_1')).toBe(true);
    expect(() => validateBlocks(checkup.blocks)).not.toThrow();
  });

  it('벤더 디스크립터가 없거나 advisorTools가 비면 그 장비는 건너뛴다', () => {
    const orphan: Device = { ...DEVICE, id: 'dev_x', product: 'UNKNOWN_PRODUCT' };
    const emptyVendorDevice: Device = { ...DEVICE, id: 'dev_y', product: 'NO_TOOLS' };
    const vendors = [...SEED_VENDORS, { product: 'NO_TOOLS', label: 'n', advisorTools: [], credentialFields: [] }];
    const out = planSeedPlaybooks([orphan, emptyVendorDevice], vendors);
    expect(out.map((c) => c.seedKey)).toEqual(['tower-selfcheck']);
  });
});

describe('validateBlocks — 플레이북 프록시 도구 차단 (중첩 실행 비범위)', () => {
  it('sangfor_playbook_* 를 tool 블록으로 쓰면 400', () => {
    expect(() => validateBlocks([{ id: 'b1', type: 'tool', toolId: 'sangfor_playbook_execute' }]))
      .toThrow(PlaybookValidationError);
  });
});

describe('POST /api/playbooks/seed — 멱등 시드', () => {
  it('첫 호출은 생성, 두 번째 호출은 skipped, 생성본은 draft라 실행 403', async () => {
    writeFileSync(join(registryDir, 'devices.json'), JSON.stringify([DEVICE]));
    tower = await startTower();
    towerUrl = `http://127.0.0.1:${(tower.address() as AddressInfo).port}`;

    const first = await call('POST', '/api/playbooks/seed', {});
    expect(first.status).toBe(200);
    const created = first.body.created as Playbook[];
    expect(created).toHaveLength(2);
    expect(created.map((p) => p.seedKey).sort()).toEqual(['device-checkup:dev_seed_1', 'tower-selfcheck']);
    expect(first.body.skipped).toBe(0);

    const second = await call('POST', '/api/playbooks/seed', {});
    expect((second.body.created as Playbook[])).toHaveLength(0);
    expect(second.body.skipped).toBe(2);

    const listed = (await call('GET', '/api/playbooks')).body.playbooks as Array<{ id: string; activeRev?: number }>;
    expect(listed).toHaveLength(2);
    expect(listed.every((p) => p.activeRev === undefined)).toBe(true); // 승인 게이트 우회 없음
    expect((await call('POST', `/api/playbooks/${listed[0].id}/execute`, {})).status).toBe(403);
  });

  it('대시보드가 시드 버튼과 핸들러를 노출하고 스크립트가 파싱된다', async () => {
    tower = await startTower();
    towerUrl = `http://127.0.0.1:${(tower.address() as AddressInfo).port}`;
    const html = await (await fetch(`${towerUrl}/`)).text();
    expect(html).toContain('onclick="seedPlaybooks()"');
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toContain('window.seedPlaybooks');
    expect(() => new Function(script as string)).not.toThrow();
  });

  it('seedOnStart=true는 기동 시 시드하고, 승인하면 시드 플레이북이 실제로 실행된다', async () => {
    tower = await startTower(true);
    towerUrl = `http://127.0.0.1:${(tower.address() as AddressInfo).port}`;

    const listed = (await call('GET', '/api/playbooks')).body.playbooks as Array<{ id: string; name: string }>;
    expect(listed.map((p) => p.name)).toEqual(['타워 자체 점검']);

    const pbId = listed[0].id;
    expect((await call('POST', `/api/playbooks/${pbId}/revisions/1/approve`, { reviewedBy: 'jmpark' })).status).toBe(200);
    const run = await call('POST', `/api/playbooks/${pbId}/execute`, {});
    expect(run.status).toBe(200);
    expect(run.body.status).toBe('succeeded');
    expect((run.body.blocks as Array<{ blockId: string }>).map((b) => b.blockId))
      .toEqual(['store', 'rag', 'spec', 'report']);
  });
});
