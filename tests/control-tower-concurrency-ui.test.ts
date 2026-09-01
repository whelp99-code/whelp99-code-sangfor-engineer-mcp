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

describe('Tower API concurrency and UI', () => {
  it('sweep: promisePool이 동시 실행을 3으로 제한한다', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const READONLY_TOOLS = Array.from({ length: 9 }, (_, i) => `stub.ro${i}`);
    const saturated = new ExactSignal('three sweep calls in flight');
    const releaseCalls = new ExactSignal('release sweep calls');
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
        if (inFlight === 3) saturated.resolve();
        await releaseCalls.promise;
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
    await new Registry(cRegDir, testLocalWriteAuthority('registry_services', cRegDir)).createDevice({ name: 'm1', product: 'MANY_FW', host: 'http://127.0.0.1:9', tags: [] });
    const cTower = createTowerServer({ authorityMode: 'local', bridgeUrl: cbUrl, runsDir: cRunsDir, registryDir: cRegDir, approvalSecret: 's', apiToken: 'test-token', mockConsoleUrl: 'http://127.0.0.1:1' });
    await new Promise<void>((r) => cTower.listen(0, '127.0.0.1', () => r()));
    try {
      const sweep = call('POST', '/api/sweep', {}, urlOf(cTower));
      await saturated.promise;
      releaseCalls.resolve();
      const r = await sweep;
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
    const res = await fetch(`${towerAddress()}/`);
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
