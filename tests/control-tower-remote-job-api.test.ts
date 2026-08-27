import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTowerServer } from '../apps/control-tower/src/server.js';
import type { AuthorityRuntimePort } from '../apps/control-tower/src/authority-runtime.js';
import type { BrowserExecutionResult } from '../packages/sangfor-browser-contracts/src/index.js';

const servers: http.Server[] = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))));

async function listen(server: http.Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new TypeError('Expected TCP listener.');
  return `http://127.0.0.1:${address.port}`;
}

function runtime(submit?: (input: unknown) => Promise<BrowserExecutionResult>): AuthorityRuntimePort {
  return {
    liveness: () => ({ ok: true, state: 'running' }),
    readiness: async () => ({ ok: true, schemaVersion: 'test', checks: {
      config: { ok: true }, database: { ok: true }, schema: { ok: true }, signing: { ok: true },
      trust: { ok: true }, scope: { ok: true }, domainApis: { ok: true }, drain: { ok: true },
    } }),
    assertReady: async () => undefined,
    enrollments: () => undefined,
    ...(submit ? { remoteJobs: () => ({ submit }) } : {}),
    localWriteAuthority: async () => { throw new TypeError('not used'); },
    beginDrain: () => undefined,
    close: async () => undefined,
  };
}

async function post(baseUrl: string, token: string): Promise<Response> {
  return fetch(`${baseUrl}/api/remote-browser-jobs`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sentinel: 'exact-body' }),
  });
}

describe('Control Tower remote job API', () => {
  it('keeps the app thin and authenticates before the lower dispatcher', async () => {
    const submit = vi.fn(async (): Promise<BrowserExecutionResult> => ({
      schemaVersion: 'browser-execution-result.v1', requestId: 'request-a', status: 'INDETERMINATE',
      mutationAttempted: true, readBack: { status: 'INDETERMINATE' }, evidence: [],
    }));
    const baseUrl = await listen(createTowerServer({ authorityMode: 'local', authorityRuntime: runtime(submit), apiToken: 'tower-token' }));
    expect((await post(baseUrl, 'wrong-token')).status).toBe(401);
    expect(submit).not.toHaveBeenCalled();
    const response = await post(baseUrl, 'tower-token');
    expect(response.status).toBe(200);
    expect(submit).toHaveBeenCalledWith({ sentinel: 'exact-body' });
  });

  it('fails closed when production dispatcher composition is unavailable', async () => {
    const baseUrl = await listen(createTowerServer({ authorityMode: 'local', authorityRuntime: runtime(), apiToken: 'tower-token' }));
    expect((await post(baseUrl, 'tower-token')).status).toBe(503);
  });
});
