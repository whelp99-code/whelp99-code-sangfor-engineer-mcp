import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createTowerServer } from '../apps/control-tower/src/server.js';
import type { AuthorityRuntimePort } from '../apps/control-tower/src/authority-runtime.js';
import { MAX_REQUEST_BODY_BYTES } from '../packages/shared/src/runtime-body-cap.js';

const TOKEN = 'authority-body-cap-token';
const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function listen(server: http.Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new TypeError('Expected TCP listener.');
  return address.port;
}

function oversizedPost(port: number, path: string): Promise<number> {
  const request = http.request({
    host: '127.0.0.1', port, path, method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
    },
  });
  const status = new Promise<number>((resolve, reject) => {
    request.on('response', (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on('error', reject);
  });
  request.end(Buffer.alloc(MAX_REQUEST_BODY_BYTES + 1, 0x78));
  return status;
}

function runtime(dispatches: { enrollment: number; remoteJob: number }): AuthorityRuntimePort {
  const enrollmentDispatch = async (): Promise<never> => {
    dispatches.enrollment += 1;
    throw new TypeError('enrollment dispatch must not run');
  };
  return {
    liveness: () => ({ ok: true, state: 'running' }),
    readiness: async () => ({ ok: true, schemaVersion: 'test', checks: {
      config: { ok: true }, database: { ok: true }, schema: { ok: true }, signing: { ok: true },
      trust: { ok: true }, scope: { ok: true }, domainApis: { ok: true }, drain: { ok: true },
    } }),
    assertReady: async () => undefined,
    enrollments: () => ({
      issueBootstrapToken: enrollmentDispatch,
      claimBootstrapToken: enrollmentDispatch,
      getByInstallation: enrollmentDispatch,
      rotate: enrollmentDispatch,
      acknowledgeRotation: enrollmentDispatch,
      revoke: enrollmentDispatch,
    }),
    remoteJobs: () => ({ submit: async () => {
      dispatches.remoteJob += 1;
      throw new TypeError('remote-job dispatch must not run');
    } }),
    localWriteAuthority: async () => { throw new TypeError('not used'); },
    beginDrain: () => undefined,
    close: async () => undefined,
  };
}

describe('Control Tower authority route body cap', () => {
  it.each([
    ['/api/enrollments/bootstrap-tokens', 'enrollment'],
    ['/api/remote-browser-jobs', 'remoteJob'],
  ] as const)('returns 413 for 64 MiB + 1 on %s without authority dispatch', async (path, counter) => {
    // Given
    const dispatches = { enrollment: 0, remoteJob: 0 };
    const port = await listen(createTowerServer({
      authorityMode: 'local', authorityRuntime: runtime(dispatches), apiToken: TOKEN,
    }));

    // When
    const status = await oversizedPost(port, path);

    // Then
    expect(status).toBe(413);
    expect(dispatches[counter]).toBe(0);
  }, 60_000);
});
