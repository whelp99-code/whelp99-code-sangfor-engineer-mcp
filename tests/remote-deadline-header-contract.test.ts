import { X509Certificate } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  BrowserExecutionContext,
  BrowserExecutionPort,
  BrowserExecutionRequest,
} from '../packages/sangfor-browser-contracts/src/browser-execution.js';
import {
  REMOTE_EXECUTION_DEADLINE_HEADER,
  createNodeHttpsTransport,
  createRemoteBrowserExecutionPort,
  createRemoteBrowserJobServer,
  fingerprintsMatch,
} from '../packages/sangfor-browser-contracts/src/remote-transport.js';
import { TestRemoteJobStore } from './helpers/remote-job-store-fake.js';
import {
  generateRemoteMtlsFixture,
  type RemoteMtlsFixture,
} from './support/remote-mtls-fixture.js';

const NOW = new Date('2026-08-20T11:00:00.000Z');
const DEADLINE = '2026-08-20T11:01:00.000Z';
const request: BrowserExecutionRequest = {
  schemaVersion: 'browser-execution-request.v1',
  requestId: 'deadline-contract',
  sessionId: 'session-deadline',
  origin: 'https://console.example',
  operation: { kind: 'observe_console' },
};

const servers: Array<{ close(): Promise<void> }> = [];
let fixture: RemoteMtlsFixture;
let serverFingerprint256: string;

beforeAll(() => {
  fixture = generateRemoteMtlsFixture();
  serverFingerprint256 = new X509Certificate(fixture.serverCert).fingerprint256;
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

afterAll(() => {
  fixture.remove();
});

function passResult(requestId: string) {
  return {
    schemaVersion: 'browser-execution-result.v1' as const,
    requestId,
    status: 'PASS' as const,
    mutationAttempted: false,
    readBack: { status: 'PASS' as const },
    evidence: [],
  };
}

async function startServer(execute: BrowserExecutionPort['execute']) {
  const server = await createRemoteBrowserJobServer({
    tls: { cert: fixture.serverCert, key: fixture.serverKey, ca: fixture.caCert },
    executor: { execute },
    jobStore: new TestRemoteJobStore(),
    authorizeClient: (identity) => fingerprintsMatch(
      identity.fingerprint256,
      fixture.authorizedClientFingerprint256,
    ),
    now: () => NOW,
  });
  servers.push(server);
  return server;
}

function connect(endpointUrl: string) {
  return createRemoteBrowserExecutionPort({
    endpointUrl,
    tls: {
      cert: fixture.authorizedClientCert,
      key: fixture.authorizedClientKey,
      ca: fixture.caCert,
      expectedServerFingerprint256: serverFingerprint256,
      servername: 'localhost',
    },
    envelope: {
      tenantId: 'tenant-deadline',
      projectId: 'project-deadline',
      capability: 'cap-deadline',
      now: () => NOW,
      ttlMs: 60_000,
    },
    transport: createNodeHttpsTransport(),
  });
}

describe('remote deadline header contract', () => {
  it('Given the remote protocol, When client and server import the deadline header, Then they share the canonical name', () => {
    expect(REMOTE_EXECUTION_DEADLINE_HEADER).toBe('x-sangfor-browser-deadline');
  });

  it('Given a remote client and server, When the client supplies a deadline, Then the executor receives that deadline through the shared header', async () => {
    const execute = vi.fn<BrowserExecutionPort['execute']>(async (input) => (
      passResult(input.requestId)
    ));
    const server = await startServer(execute);
    const executionContext: BrowserExecutionContext = {
      signal: new AbortController().signal,
      deadline: DEADLINE,
    };

    const result = await connect(server.baseUrl).execute(request, executionContext);

    expect(result.status).toBe('PASS');
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[1]?.deadline).toBe(DEADLINE);
    expect(execute.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(execute.mock.calls[0]?.[1]?.signal).not.toBe(executionContext.signal);
  });

  it('Given a remote dispatch without a deadline header, When the job runs, Then the executor is invoked without an execution context', async () => {
    const execute = vi.fn<BrowserExecutionPort['execute']>(async (input) => (
      passResult(input.requestId)
    ));
    const server = await startServer(execute);

    await connect(server.baseUrl).execute(request);

    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[1]).toBeUndefined();
  });
});
