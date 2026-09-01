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

describe('Tower API — 인증/검증 (T-API-1)', () => {
  it('토큰 없으면 /api/*는 401, 잘못된 토큰도 401', async () => {
    expect((await call('GET', '/api/runs', undefined, towerAddress(), '')).status).toBe(401);
    expect((await call('GET', '/api/runs', undefined, towerAddress(), 'wrong')).status).toBe(401);
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
    expect(observedCall()!.arguments.password).toBe('p'); // 실행에는 원본이 나감

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
    writeFileSync(join(registryRoot(), 'vendors.json'), JSON.stringify([{
      product: 'STUB_FW', label: 'Stub FW',
      advisorTools: ['stub.read'], credentialFields: ['host', 'username', 'password'],
      defaultArgs: { specVersion: '1.0' },
    } satisfies VendorDescriptor]));
    const device = await new Registry(registryRoot(), testLocalWriteAuthority('registry_services', registryRoot())).createDevice({ name: 's1', product: 'STUB_FW', host: 'http://127.0.0.1:9', tags: [] });
    const r = await call('POST', '/api/runs', { toolId: 'stub.read', deviceId: device.id, args: { specVersion: '9.9' } });
    expect((r.body as unknown as RunRecord).deviceId).toBe(device.id);
    expect(observedCall()!.arguments).toEqual({
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
    expect(observedCall()).toBeNull(); // 아직 bridge 호출 없음
    expect((await call('GET', '/api/runs?status=pending_approval')).body.runs).toHaveLength(1);

    const approved = await call('POST', `/api/runs/${pending.runId}/approve`, { approvedBy: 'jmpark' });
    const final = approved.body as unknown as RunRecord;
    expect(final.status).toBe('succeeded');
    expect(final.approval).toMatchObject({ approvedBy: 'jmpark', changeTicketId: `run:${pending.runId}`, rollbackPlanId: 'n/a-read-back-verify' , authorityEpoch: 0});
    expect(JSON.stringify(final)).not.toMatch(/approvalToken|nonce/); // 토큰·nonce 무저장
    expect(String(final.resultSummary)).toContain('***');      // 요약도 마스킹본 기준
    expect(String(final.resultSummary)).not.toContain('hunter2');  // 비밀값 요약 유출 금지
    expect(observedCall()!.name).toBe('stub.write');
    expect(observedCall()!.arguments.password).toBe('hunter2'); // 원본 args로 실행 (마스킹본 아님)
    expect(observedCall()!.approval).toMatchObject({ approvedBy: 'jmpark' });
    expect(typeof observedCall()!.approval!.approvalToken).toBe('string');

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
    const restarted = await startTower(); // 같은 runsRoot()/registryRoot(), 새 프로세스 상태
    try {
      const r = await call('POST', `/api/runs/${pending.runId}/approve`, { approvedBy: 'x' }, urlOf(restarted));
      expect(r.status).toBe(400);
      expect(String(r.body.error)).toMatch(/원본 인자 소실/);
    } finally {
      await new Promise<void>((r) => restarted.close(() => r()));
    }
  });
});
