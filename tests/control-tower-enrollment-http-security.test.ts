import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTowerServer } from '../apps/control-tower/src/server.js';
import {
  isEnrollmentLoopbackPeer,
} from '../apps/control-tower/src/authority-enrollment-routes.js';
import type { AuthorityRuntimePort } from '../apps/control-tower/src/authority-runtime.js';

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function listen(server: http.Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new TypeError('Expected TCP listener.');
  return `http://127.0.0.1:${address.port}`;
}

function runtime(
  ready: boolean,
  authorityDatabaseReadiness?: () => void,
  authorityCacheLookup?: () => void,
): AuthorityRuntimePort {
  return {
    liveness: () => ({ ok: true, state: 'running' }),
    readiness: async () => {
      authorityDatabaseReadiness?.();
      return {
        ok: ready, schemaVersion: 'test', checks: {
          config: { ok: ready }, database: { ok: ready }, schema: { ok: ready },
          signing: { ok: ready }, trust: { ok: ready }, scope: { ok: ready },
          domainApis: { ok: ready }, drain: { ok: true },
        },
      };
    },
    assertReady: async () => undefined,
    enrollments: () => {
      authorityCacheLookup?.();
      return undefined;
    },
    localWriteAuthority: async () => { throw new Error('not used'); },
    beginDrain: () => undefined,
    close: async () => undefined,
  };
}

async function post(baseUrl: string, token?: string, body = '{}'): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await fetch(`${baseUrl}/api/enrollments/bootstrap-tokens`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body,
  });
  return { status: response.status, body: await response.json() };
}

describe('Control Tower enrollment HTTP security', () => {
  it('returns uniform 401 before authority or body access for every unauthenticated body shape', async () => {
    // Given
    const authorityDatabaseReadiness = vi.fn();
    const authorityCacheLookup = vi.fn();
    const baseUrl = await listen(createTowerServer({
      authorityMode: 'local',
      authorityRuntime: runtime(false, authorityDatabaseReadiness, authorityCacheLookup),
      apiToken: 'route-token',
    }));
    const target = new URL('/api/enrollments/bootstrap-tokens', baseUrl);
    const oversizedRequest = http.request({
      host: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(256 * 1024 * 1024),
      },
    });
    const oversizedResponse = new Promise<{ readonly status: number; readonly body: unknown }>((resolve, reject) => {
      oversizedRequest.once('error', reject);
      oversizedRequest.once('response', (response) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of response) chunks.push(Buffer.from(chunk));
          oversizedRequest.destroy();
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
          });
        })().catch(reject);
      });
    });

    // When
    const responses = await Promise.all([
      post(baseUrl),
      post(baseUrl, undefined, '{'),
      (oversizedRequest.write('{'), oversizedResponse),
    ]);

    // Then
    expect(responses).toEqual([
      { status: 401, body: { error: 'unauthorized' } },
      { status: 401, body: { error: 'unauthorized' } },
      { status: 401, body: { error: 'unauthorized' } },
    ]);
    expect(authorityDatabaseReadiness).not.toHaveBeenCalled();
    expect(authorityCacheLookup).not.toHaveBeenCalled();
  });

  it('requires a configured exact bearer token even on loopback', async () => {
    const gated = await listen(createTowerServer({ authorityMode: 'local', authorityRuntime: runtime(true), apiToken: 'route-token' }));
    await expect(post(gated)).resolves.toMatchObject({ status: 401 });
    await expect(post(gated, 'wrong')).resolves.toMatchObject({ status: 401 });
    const unset = await listen(createTowerServer({ authorityMode: 'local', authorityRuntime: runtime(true), apiToken: '' }));
    await expect(post(unset)).resolves.toMatchObject({ status: 503 });
  });

  it('accepts only actual loopback socket address forms', () => {
    expect(isEnrollmentLoopbackPeer('127.0.0.1')).toBe(true);
    expect(isEnrollmentLoopbackPeer('127.255.0.7')).toBe(true);
    expect(isEnrollmentLoopbackPeer('::1')).toBe(true);
    expect(isEnrollmentLoopbackPeer('::ffff:127.0.0.9')).toBe(true);
    expect(isEnrollmentLoopbackPeer('10.0.0.1')).toBe(false);
    expect(isEnrollmentLoopbackPeer(undefined)).toBe(false);
  });
});
