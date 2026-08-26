import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTowerServer } from '../apps/control-tower/src/server.js';
import { AuthorityUnavailableError, type AuthorityRuntimePort } from '../apps/control-tower/src/authority-runtime.js';

const servers: http.Server[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function listen(server: http.Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function readinessRuntime(): AuthorityRuntimePort & { setReady(value: boolean): void } {
  let ready = true;
  let state: 'running' | 'draining' | 'closed' = 'running';
  return {
    setReady(value) { ready = value; },
    liveness: () => ({ ok: state !== 'closed', state }),
    async readiness() {
      return {
        ok: ready && state === 'running', schemaVersion: 'test',
        checks: {
          config: { ok: true }, database: { ok: ready }, schema: { ok: ready },
          signing: { ok: true }, trust: { ok: true }, scope: { ok: ready },
          domainApis: { ok: ready }, drain: { ok: state === 'running' },
        },
      };
    },
    async assertReady() {
      if (!ready || state !== 'running') throw new AuthorityUnavailableError('DATABASE_UNAVAILABLE');
    },
    enrollments: () => undefined,
    beginDrain() { state = 'draining'; },
    async close() { state = 'closed'; },
  };
}

async function request(baseUrl: string, path: string, method = 'GET'): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify({ toolId: 'write.tool', args: {} }) } : {}),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

describe('control-tower process health', () => {
  it('keeps health/live process-only while ready reflects authority dependencies', async () => {
    const runtime = readinessRuntime();
    const root = mkdtempSync(join(tmpdir(), 'tower-ready-'));
    roots.push(root);
    const server = createTowerServer({
      authorityRuntime: runtime,
      apiToken: 'test-token',
      runsDir: join(root, 'runs'), registryDir: join(root, 'registry'),
      approvalSecret: 'test-secret', mockConsoleUrl: 'http://127.0.0.1:1',
    });
    const baseUrl = await listen(server);

    expect((await request(baseUrl, '/health')).status).toBe(200);
    expect((await request(baseUrl, '/live')).status).toBe(200);
    expect((await request(baseUrl, '/ready')).status).toBe(200);
    expect(existsSync(join(root, 'runs'))).toBe(false);
    expect(existsSync(join(root, 'registry'))).toBe(false);

    runtime.setReady(false);

    expect((await request(baseUrl, '/ready')).status).toBe(503);
    expect((await request(baseUrl, '/health')).status).toBe(200);
    expect((await request(baseUrl, '/live')).body).toMatchObject({ ok: true, state: 'running' });
  });

  it('refuses a new dispatch before contacting the bridge when authority is unready', async () => {
    const bridgeCalls = vi.fn();
    const bridge = http.createServer((request, response) => {
      bridgeCalls(request.url);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ tools: [] }));
    });
    const bridgeUrl = await listen(bridge);
    const runtime = readinessRuntime();
    runtime.setReady(false);
    const root = mkdtempSync(join(tmpdir(), 'tower-unready-'));
    roots.push(root);
    const tower = createTowerServer({
      authorityRuntime: runtime, bridgeUrl, apiToken: 'test-token',
      runsDir: join(root, 'runs'), registryDir: join(root, 'registry'),
      approvalSecret: 'test-secret', mockConsoleUrl: 'http://127.0.0.1:1',
    });
    const towerUrl = await listen(tower);

    const response = await request(towerUrl, '/api/runs', 'POST');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: 'BLRO authority is not ready', reason: 'DATABASE_UNAVAILABLE',
    });
    expect(bridgeCalls).not.toHaveBeenCalled();
  });
});
