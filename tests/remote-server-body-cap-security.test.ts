import { request as httpsRequest, type RequestOptions } from 'node:https';
import type { ClientRequest } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  BLRO_CONTRACT_VERSION,
  CONTRACT_VERSION_HEADER,
  REMOTE_BROWSER_JOB_PATH,
  REMOTE_TRANSPORT_ERROR_CODES,
  buildRemoteJobEnvelope,
  createRemoteBrowserJobServer,
  fingerprintsMatch,
  formatContractVersion,
  type RemoteJobStore,
} from '../packages/sangfor-browser-contracts/src/remote-transport.js';
import type { BrowserExecutionRequest } from '../packages/sangfor-browser-contracts/src/browser-execution.js';
import { TestRemoteJobStore } from './helpers/remote-job-store-fake.js';
import {
  generateRemoteMtlsFixture,
  type RemoteMtlsFixture,
} from './support/remote-mtls-fixture.js';

const BODY_CAP_BYTES = 64 * 1024;
const declaredVersion = formatContractVersion(BLRO_CONTRACT_VERSION);
const issuedAt = new Date('2026-08-31T10:00:00.000Z');
const servers: Array<{ close(): Promise<void> }> = [];
let fixture: RemoteMtlsFixture;

beforeAll(() => {
  fixture = generateRemoteMtlsFixture();
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

afterAll(() => {
  fixture.remove();
});

interface LoopbackResponse {
  readonly statusCode: number | undefined;
  readonly body: string;
}

function receiveResponse(
  request: ClientRequest,
  send: () => void,
): Promise<LoopbackResponse> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      request.destroy();
      reject(new Error('Loopback server did not refuse the request before the remaining body.'));
    }, 2_000);
    request.once('response', (response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of response) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        clearTimeout(timeout);
        request.destroy();
        resolve({
          statusCode: response.statusCode,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      })().catch(reject);
    });
    request.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    send();
  });
}

function clientRequest(
  port: number,
  options: RequestOptions,
): ClientRequest {
  return httpsRequest({
    host: '127.0.0.1',
    port,
    ca: fixture.caCert,
    servername: 'localhost',
    method: 'POST',
    path: REMOTE_BROWSER_JOB_PATH,
    ...options,
    headers: { [CONTRACT_VERSION_HEADER]: declaredVersion, ...options.headers },
  });
}

async function startServer(input: {
  readonly authorizeClient: (fingerprint256: string) => boolean;
  readonly store: RemoteJobStore;
  readonly execute: (request: BrowserExecutionRequest) => Promise<never>;
  readonly rejectUnauthorized?: boolean;
}) {
  const server = await createRemoteBrowserJobServer({
    tls: {
      cert: fixture.serverCert,
      key: fixture.serverKey,
      ca: fixture.caCert,
      ...(input.rejectUnauthorized === undefined
        ? {}
        : { rejectUnauthorized: input.rejectUnauthorized }),
    },
    executor: { execute: input.execute },
    authorizeClient: (identity) => input.authorizeClient(identity.fingerprint256),
    jobStore: input.store,
    now: () => issuedAt,
  });
  servers.push(server);
  return server;
}

function untouchedApplication() {
  return {
    store: new TestRemoteJobStore(),
    execute: vi.fn(async (): Promise<never> => {
      throw new Error('Execution must not be reached.');
    }),
  };
}

describe('remote server body cap and authorization order', () => {
  it('refuses a CA-valid revoked client before consuming its slow chunked body or looking up a job', async () => {
    // Given
    const application = untouchedApplication();
    const authorizeClient = vi.fn(() => false);
    const server = await startServer({ authorizeClient, ...application });
    const request = clientRequest(server.port, {
      cert: fixture.revokedClientCert,
      key: fixture.revokedClientKey,
      headers: { 'transfer-encoding': 'chunked' },
    });

    // When
    const response = await receiveResponse(request, () => {
      request.write(Buffer.alloc(BODY_CAP_BYTES + 1, 'a'));
    });

    // Then
    expect(response.statusCode).toBe(403);
    expect(authorizeClient).toHaveBeenCalledOnce();
    expect(application.store.reserves).toEqual([]);
    expect(application.execute).not.toHaveBeenCalled();
  });

  it('refuses an authorized Content-Length over the cap before receiving body bytes', async () => {
    // Given
    const application = untouchedApplication();
    const server = await startServer({ authorizeClient: () => true, ...application });
    const request = clientRequest(server.port, {
      cert: fixture.authorizedClientCert,
      key: fixture.authorizedClientKey,
      headers: { 'content-length': String(BODY_CAP_BYTES + 1) },
    });

    // When
    const response = await receiveResponse(request, () => request.flushHeaders());

    // Then
    expect(response.statusCode).toBe(413);
    expect(response.body).toContain(REMOTE_TRANSPORT_ERROR_CODES.BODY_TOO_LARGE);
    expect(application.store.reserves).toEqual([]);
  });

  it('drops the entire chunk that crosses the cap without exposing or looking up its contents', async () => {
    // Given
    const application = untouchedApplication();
    const server = await startServer({ authorizeClient: () => true, ...application });
    const secret = 'crossing-chunk-secret';
    const request = clientRequest(server.port, {
      cert: fixture.authorizedClientCert,
      key: fixture.authorizedClientKey,
      headers: { 'transfer-encoding': 'chunked' },
    });

    // When
    const response = await receiveResponse(request, () => {
      request.write(Buffer.alloc(BODY_CAP_BYTES, 'a'));
      request.write(secret);
    });

    // Then
    expect(response.statusCode).toBe(413);
    expect(response.body).not.toContain(secret);
    expect(application.store.reserves).toEqual([]);
    expect(application.execute).not.toHaveBeenCalled();
  });

  it('orders path and method refusal before mTLS and registry authorization', async () => {
    // Given
    const application = untouchedApplication();
    const authorizeClient = vi.fn(() => false);
    const server = await startServer({
      authorizeClient,
      rejectUnauthorized: false,
      ...application,
    });
    const rogueTls = { cert: fixture.rogueClientCert, key: fixture.rogueClientKey };

    // When
    const missingRequest = clientRequest(server.port, {
      ...rogueTls,
      path: '/missing',
      headers: { 'content-length': '0' },
    });
    const missing = await receiveResponse(missingRequest, () => missingRequest.end());
    const wrongMethodRequest = clientRequest(server.port, {
      ...rogueTls,
      method: 'GET',
      headers: { 'content-length': '0' },
    });
    const wrongMethod = await receiveResponse(wrongMethodRequest, () => wrongMethodRequest.end());
    const invalidTlsRequest = clientRequest(server.port, {
      ...rogueTls,
      headers: { 'content-length': '0' },
    });
    const invalidTls = await receiveResponse(invalidTlsRequest, () => invalidTlsRequest.end());
    const revokedRequest = clientRequest(server.port, {
      cert: fixture.revokedClientCert,
      key: fixture.revokedClientKey,
      headers: { 'content-length': '0' },
    });
    const revoked = await receiveResponse(revokedRequest, () => revokedRequest.end());

    // Then
    expect([missing.statusCode, wrongMethod.statusCode, invalidTls.statusCode, revoked.statusCode])
      .toEqual([404, 405, 401, 403]);
    expect(authorizeClient).toHaveBeenCalledOnce();
    expect(application.store.reserves).toEqual([]);
  });

  it('accepts an authorized envelope below the cap', async () => {
    // Given
    const execute = vi.fn(async (request: BrowserExecutionRequest) => ({
      schemaVersion: 'browser-execution-result.v1' as const,
      requestId: request.requestId,
      status: 'PASS' as const,
      mutationAttempted: false,
      readBack: { status: 'PASS' as const },
      evidence: [],
    }));
    const store = new TestRemoteJobStore();
    const server = await createRemoteBrowserJobServer({
      tls: { cert: fixture.serverCert, key: fixture.serverKey, ca: fixture.caCert },
      executor: { execute },
      authorizeClient: (identity) => fingerprintsMatch(
        identity.fingerprint256,
        fixture.authorizedClientFingerprint256,
      ),
      jobStore: store,
      now: () => issuedAt,
    });
    servers.push(server);
    const body = JSON.stringify(buildRemoteJobEnvelope({
      schemaVersion: 'browser-execution-request.v1',
      requestId: 'body-cap-happy',
      sessionId: 'session-body-cap',
      origin: 'https://console.example',
      operation: { kind: 'observe_console' },
    }, {
      tenantId: 'tenant-a', projectId: 'project-a', capability: 'capability-a',
      now: () => issuedAt, ttlMs: 60_000,
    }));
    const request = clientRequest(server.port, {
      cert: fixture.authorizedClientCert,
      key: fixture.authorizedClientKey,
      headers: { 'content-length': String(Buffer.byteLength(body)) },
    });

    // When
    const response = await receiveResponse(request, () => request.end(body));

    // Then
    expect(response.statusCode).toBe(200);
    expect(execute).toHaveBeenCalledOnce();
    expect(store.reserves).toEqual(['body-cap-happy']);
  });
});
