import { testLocalWriteAuthority } from './helpers/local-write-authority.js';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createTowerServer } from '../apps/control-tower/src/server.js';
import { Registry, type VendorDescriptor } from '../apps/control-tower/src/registry.js';
import type { RunRecord } from '@sangfor/runs';
import { ExactSignal } from './helpers/exact-signal.js';
import {
  bridgeAddress, call, observedCall, registryRoot, runsRoot, startTower, towerAddress, urlOf,
} from './helpers/control-tower-api-fixture.js';

describe('Tower API — devices/sweep/overview/health (T-API-2)', () => {
  function seedStubVendor() {
    writeFileSync(join(registryRoot(), 'vendors.json'), JSON.stringify([{
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
    const device = await new Registry(registryRoot(), testLocalWriteAuthority('registry_services', registryRoot())).createDevice({ name: 's1', product: 'STUB_FW', host: 'http://127.0.0.1:9', tags: [] });
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
    const device = await new Registry(registryRoot(), testLocalWriteAuthority('registry_services', registryRoot())).createDevice({ name: 's1', product: 'STUB_FW', host: 'http://127.0.0.1:9', tags: [] });
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
    expect(health.store.ok).toBe(false); // stub bridge가 sangfor_store_health를 모름 → 404/error
    expect(health.rag.ok).toBe(false);
    expect(health.mockConsole.ok).toBe(false);
  });

  it('loop status 라우트: 선언된 그래프 요약과 게이트 목록을 반환한다 (read-only)', async () => {
    const r = await call('GET', '/api/loop/status');
    expect(r.status).toBe(200);
    const body = r.body as { nodes: number; edges: number; gates: string[]; pendingByEdge: Record<string, number> };
    expect(body.nodes).toBeGreaterThan(0);
    expect(body.edges).toBeGreaterThan(0);
    expect(Array.isArray(body.gates)).toBe(true);
    expect(typeof body.pendingByEdge).toBe('object');
  });

  it('mint 라우트: 시크릿 있으면 SignedApproval 반환, 필수 필드 누락 400', async () => {
    const r = await call('POST', '/api/approvals/mint', {
      actionType: 'hci.create-volume', actionTarget: '127.0.0.1:vol-a',
      approvedBy: 'jmpark', changeTicketId: 'CHG-1', rollbackPlanId: 'RB-1', ttlSec: 60,
     authorityEpoch: 0});
    expect(r.status).toBe(200);
    expect(typeof r.body.approvalToken).toBe('string');
    expect(typeof r.body.nonce).toBe('string');
    expect((await call('POST', '/api/approvals/mint', { actionType: 'x' })).status).toBe(400);

    // TTL은 600초로 클램프된다 (과도한 장수명 승인 방지)
    const now = Date.now();
    const clamped = await call('POST', '/api/approvals/mint', {
      actionType: 'hci.create-volume', actionTarget: 'h:v',
      approvedBy: 'a', changeTicketId: 'c', rollbackPlanId: 'r', ttlSec: 99999,
     authorityEpoch: 0});
    const ttlMs = new Date(String(clamped.body.expiresAt)).getTime() - now;
    expect(ttlMs).toBeLessThanOrEqual(600_000 + 5_000); // 600s + 여유
    expect(ttlMs).toBeGreaterThan(590_000);
  });

  it('mint: 시크릿 미설정 시 500 fail-closed', async () => {
    const bare = await startTower({ approvalSecret: '' });
    try {
      const r = await call('POST', '/api/approvals/mint', {
        actionType: 'hci.create-volume', actionTarget: 'h:vol',
        approvedBy: 'jmpark', changeTicketId: 'CHG-1', rollbackPlanId: 'RB-1',
       authorityEpoch: 0}, urlOf(bare));
      expect(r.status).toBe(500);
      expect(String(r.body.error)).toMatch(/approval secret not configured/);
    } finally {
      await new Promise<void>((res) => bare.close(() => res()));
    }
  });

});
