import { execFileSync } from 'node:child_process';
import { X509Certificate, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  browserExecutionResultSchema,
  isAuthoritativePass,
  type BrowserExecutionRequest,
  type BrowserExecutionResult,
} from '../packages/sangfor-browser-contracts/src/index.js';
import {
  REMOTE_BROWSER_JOB_PATH,
  REMOTE_TRANSPORT_ERROR_CODES,
  buildRemoteJobEnvelope,
  createRemoteBrowserExecutionPort,
  createRemoteBrowserJobHandler,
  createRemoteBrowserJobServer,
  createNodeHttpsTransport,
  fingerprintsMatch,
  type JobIdempotencyStore,
} from '../packages/sangfor-browser-contracts/src/remote-transport.js';
import { mintJobCapability } from '../packages/sangfor-browser-contracts/src/capability.js';

const issuedAt = new Date('2026-08-12T10:00:00.000Z');
const capabilityKeys = generateKeyPairSync('ed25519');
const privateKey = capabilityKeys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const baseRequest = (
  operation: BrowserExecutionRequest['operation'],
  requestId = `request-${operation.kind}`,
): BrowserExecutionRequest => ({
  schemaVersion: 'browser-execution-request.v1',
  requestId,
  sessionId: 'session-remote-1',
  origin: 'http://127.0.0.1:3400',
  operation,
});
const passResult = (
  requestId: string,
  observations: Record<string, string> = {},
): BrowserExecutionResult => browserExecutionResultSchema.parse({
  schemaVersion: 'browser-execution-result.v1',
  requestId,
  status: 'PASS',
  mutationAttempted: false,
  readBack: { status: 'PASS' },
  observations,
  evidence: [],
});

function envelopeOptions() {
  return {
    tenantId: 'tenant-a',
    projectId: 'project-a',
    runId: 'run-a',
    stepId: 'step-a',
    now: () => issuedAt,
    ttlMs: 60_000,
    capability: ({ request, runId, stepId, jobId, issuedAt: issued, expiresAt }: {
      request: BrowserExecutionRequest;
      runId: string;
      stepId: string;
      jobId: string;
      issuedAt: Date;
      expiresAt: Date;
    }) => mintJobCapability({
      tenantId: 'tenant-a',
      projectId: 'project-a',
      runId,
      stepId,
      jobId,
      clientIdentityId: 'client:install-a',
      installationId: 'install-a',
      request,
      issuedAt: issued,
      expiresAt,
      jti: `cap-${jobId}`,
      privateKey,
    }),
  };
}

describe('Phase 4 remote transport deterministic semantics', () => {
  it('round-trips the unchanged BrowserExecutionPort contract', async () => {
    const request = baseRequest({ kind: 'observe_console', includeSnapshot: true });
    const execute = vi.fn(async (input: BrowserExecutionRequest) => (
      passResult(input.requestId, { title: 'Sangfor Mock Console' })
    ));
    const handler = createRemoteBrowserJobHandler({
      executor: { execute },
      authorizeClient: () => true,
      now: () => issuedAt,
    });
    const port = createRemoteBrowserExecutionPort({
      endpointUrl: `https://jm.example${REMOTE_BROWSER_JOB_PATH}`,
      tls: {
        cert: 'cert',
        key: 'key',
        ca: 'ca',
        expectedServerFingerprint256: 'a'.repeat(64),
      },
      envelope: envelopeOptions(),
      transport: async (remoteRequest, hooks) => {
        hooks.markDispatched();
        const response = await handler.handle({
          client: {
            fingerprint256: 'client-a',
            tlsAuthorized: true,
            raw: {},
          },
          method: remoteRequest.method,
          urlPath: remoteRequest.url.pathname,
          bodyText: remoteRequest.body,
        });
        return { statusCode: response.statusCode, body: response.bodyText };
      },
    });

    const result = await port.execute(request);
    expect(result.observations).toEqual({ title: 'Sangfor Mock Console' });
    expect(isAuthoritativePass(result)).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('returns a stored duplicate result without executing or authorizing twice', async () => {
    const request = baseRequest({ kind: 'observe_console' }, 'job-duplicate');
    const execute = vi.fn(async (input: BrowserExecutionRequest) => (
      passResult(input.requestId, { calls: String(execute.mock.calls.length) })
    ));
    const preExecution = vi.fn(async () => ({ allow: true as const }));
    const handler = createRemoteBrowserJobHandler({
      executor: { execute },
      authorizeClient: () => true,
      preExecution,
      now: () => issuedAt,
    });
    const input = {
      client: { fingerprint256: 'client-a', tlsAuthorized: true, raw: {} },
      method: 'POST',
      urlPath: REMOTE_BROWSER_JOB_PATH,
      bodyText: JSON.stringify(
        buildRemoteJobEnvelope(request, envelopeOptions()),
      ),
    };

    const first = await handler.handle(input);
    const second = await handler.handle(input);

    expect(first.bodyText).toBe(second.bodyText);
    expect(preExecution).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
  });

  it('uses a durable idempotency seam supplied by the JM host', async () => {
    const records = new Map<string, BrowserExecutionResult>();
    const store: JobIdempotencyStore = {
      get: async (jobId) => records.get(jobId),
      put: async (jobId, result) => {
        records.set(jobId, result);
      },
    };
    const request = baseRequest({ kind: 'observe_console' }, 'job-durable');
    const execute = vi.fn(async (input: BrowserExecutionRequest) => passResult(input.requestId));
    const handler = createRemoteBrowserJobHandler({
      executor: { execute },
      authorizeClient: () => true,
      idempotencyStore: store,
      now: () => issuedAt,
    });
    const input = {
      client: { fingerprint256: 'client-a', tlsAuthorized: true, raw: {} },
      method: 'POST',
      urlPath: REMOTE_BROWSER_JOB_PATH,
      bodyText: JSON.stringify(
        buildRemoteJobEnvelope(request, envelopeOptions()),
      ),
    };

    await handler.handle(input);
    await handler.handle(input);
    expect(records.has('job-durable')).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('maps post-dispatch loss to INDETERMINATE and never retries', async () => {
    const transport = vi.fn(async (_request, hooks) => {
      hooks.markDispatched();
      throw new Error('socket hang up');
    });
    const port = createRemoteBrowserExecutionPort({
      endpointUrl: `https://jm.example${REMOTE_BROWSER_JOB_PATH}`,
      tls: {
        cert: 'cert',
        key: 'key',
        ca: 'ca',
        expectedServerFingerprint256: 'a'.repeat(64),
      },
      envelope: envelopeOptions(),
      transport,
    });

    const result = await port.execute(baseRequest({
      kind: 'perform_console_action',
      action: { type: 'click', target: 'Apply', dryRun: false },
    }));
    expect(transport).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      status: 'INDETERMINATE',
      mutationAttempted: true,
      readBack: { status: 'INDETERMINATE' },
      error: { code: REMOTE_TRANSPORT_ERROR_CODES.DISCONNECT_AFTER_DISPATCH },
    });
    expect(isAuthoritativePass(result)).toBe(false);
  });

  it('maps pre-dispatch loss to REFUSED without claiming mutation', async () => {
    const transport = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    const port = createRemoteBrowserExecutionPort({
      endpointUrl: `https://jm.example${REMOTE_BROWSER_JOB_PATH}`,
      tls: {
        cert: 'cert',
        key: 'key',
        ca: 'ca',
        expectedServerFingerprint256: 'a'.repeat(64),
      },
      envelope: envelopeOptions(),
      transport,
    });

    const result = await port.execute(baseRequest({ kind: 'observe_console' }));
    expect(transport).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      status: 'REFUSED',
      mutationAttempted: false,
      error: { code: REMOTE_TRANSPORT_ERROR_CODES.TRANSPORT_UNAVAILABLE },
    });
  });

  it('treats truncated 2xx and requestId mismatch as INDETERMINATE', async () => {
    const request = baseRequest({ kind: 'observe_console' });
    const responses = [
      { statusCode: 200, body: '{"status":"PASS"' },
      {
        statusCode: 200,
        body: JSON.stringify(passResult('another-request')),
      },
    ];
    for (const response of responses) {
      const port = createRemoteBrowserExecutionPort({
        endpointUrl: `https://jm.example${REMOTE_BROWSER_JOB_PATH}`,
        tls: {
          cert: 'cert',
          key: 'key',
          ca: 'ca',
          expectedServerFingerprint256: 'a'.repeat(64),
        },
        envelope: envelopeOptions(),
        transport: async (_remoteRequest, hooks) => {
          hooks.markDispatched();
          return response;
        },
      });
      expect(await port.execute(request)).toMatchObject({
        status: 'INDETERMINATE',
        error: { code: REMOTE_TRANSPORT_ERROR_CODES.DISCONNECT_AFTER_DISPATCH },
      });
    }
  });

  it('refuses non-HTTPS configuration and schema-invalid requests before dispatch', async () => {
    expect(() => createRemoteBrowserExecutionPort({
      endpointUrl: `http://jm.example${REMOTE_BROWSER_JOB_PATH}`,
      tls: {
        cert: 'cert',
        key: 'key',
        ca: 'ca',
        expectedServerFingerprint256: 'a'.repeat(64),
      },
      envelope: envelopeOptions(),
    })).toThrow(/https/i);

    const transport = vi.fn();
    const port = createRemoteBrowserExecutionPort({
      endpointUrl: `https://jm.example${REMOTE_BROWSER_JOB_PATH}`,
      tls: {
        cert: 'cert',
        key: 'key',
        ca: 'ca',
        expectedServerFingerprint256: 'a'.repeat(64),
      },
      envelope: envelopeOptions(),
      transport,
    });
    await expect(port.execute({
      schemaVersion: 'browser-execution-request.v1',
      requestId: '../escape',
      sessionId: 'session',
      origin: 'http://127.0.0.1:3400',
      operation: { kind: 'observe_console' },
    })).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
});

interface MtlsFixture {
  readonly dir: string;
  readonly caCert: string;
  readonly serverCert: string;
  readonly serverKey: string;
  readonly serverFingerprint256: string;
  readonly authorizedClientCert: string;
  readonly authorizedClientKey: string;
  readonly authorizedClientFingerprint256: string;
  readonly unauthorizedClientCert: string;
  readonly unauthorizedClientKey: string;
}

function openssl(args: string[], cwd: string): void {
  execFileSync('openssl', args, { cwd, stdio: 'pipe' });
}

function generateMtlsFixture(): MtlsFixture {
  const dir = mkdtempSync(join(tmpdir(), 'blro-phase4-mtls-'));
  openssl([
    'req', '-x509', '-newkey', 'rsa:2048', '-keyout', 'ca.key', '-out', 'ca.crt',
    '-days', '1', '-nodes', '-subj', '/CN=BLRO-Phase4-Test-CA',
  ], dir);
  openssl([
    'req', '-newkey', 'rsa:2048', '-keyout', 'server.key', '-out', 'server.csr',
    '-nodes', '-subj', '/CN=localhost',
  ], dir);
  writeFileSync(join(dir, 'server.ext'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\n');
  openssl([
    'x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key',
    '-CAcreateserial', '-out', 'server.crt', '-days', '1', '-extfile', 'server.ext',
  ], dir);
  for (const [name, cn] of [['client-ok', 'blro-authorized'], ['client-bad', 'blro-revoked']]) {
    openssl([
      'req', '-newkey', 'rsa:2048', '-keyout', `${name}.key`, '-out', `${name}.csr`,
      '-nodes', '-subj', `/CN=${cn}`,
    ], dir);
    openssl([
      'x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key',
      '-CAcreateserial', '-out', `${name}.crt`, '-days', '1',
    ], dir);
  }
  const read = (name: string) => readFileSync(join(dir, name), 'utf8');
  const serverCert = read('server.crt');
  const authorizedClientCert = read('client-ok.crt');
  return {
    dir,
    caCert: read('ca.crt'),
    serverCert,
    serverKey: read('server.key'),
    serverFingerprint256: new X509Certificate(serverCert).fingerprint256,
    authorizedClientCert,
    authorizedClientKey: read('client-ok.key'),
    authorizedClientFingerprint256:
      new X509Certificate(authorizedClientCert).fingerprint256,
    unauthorizedClientCert: read('client-bad.crt'),
    unauthorizedClientKey: read('client-bad.key'),
  };
}

const servers: Array<{ close(): Promise<void> }> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('Phase 4 remote transport real mTLS', () => {
  it('accepts the pinned BLRO client and refuses a revoked client before execution', async () => {
    const fixture = generateMtlsFixture();
    tempDirs.push(fixture.dir);
    const execute = vi.fn(async (input: BrowserExecutionRequest) => (
      passResult(input.requestId, { via: 'mtls' })
    ));
    const server = await createRemoteBrowserJobServer({
      host: '127.0.0.1',
      port: 0,
      tls: {
        cert: fixture.serverCert,
        key: fixture.serverKey,
        ca: fixture.caCert,
      },
      executor: { execute },
      authorizeClient: (identity) => fingerprintsMatch(
        identity.fingerprint256,
        fixture.authorizedClientFingerprint256,
      ),
      now: () => issuedAt,
    });
    servers.push(server);

    const authorizedPort = createRemoteBrowserExecutionPort({
      endpointUrl: server.baseUrl,
      tls: {
        cert: fixture.authorizedClientCert,
        key: fixture.authorizedClientKey,
        ca: fixture.caCert,
        expectedServerFingerprint256: fixture.serverFingerprint256,
        servername: 'localhost',
      },
      envelope: envelopeOptions(),
      transport: createNodeHttpsTransport(),
    });
    const ok = await authorizedPort.execute(
      baseRequest({ kind: 'observe_console' }, 'mtls-ok'),
    );
    expect(ok).toMatchObject({ status: 'PASS', observations: { via: 'mtls' } });

    const revokedPort = createRemoteBrowserExecutionPort({
      endpointUrl: server.baseUrl,
      tls: {
        cert: fixture.unauthorizedClientCert,
        key: fixture.unauthorizedClientKey,
        ca: fixture.caCert,
        expectedServerFingerprint256: fixture.serverFingerprint256,
        servername: 'localhost',
      },
      envelope: envelopeOptions(),
      transport: createNodeHttpsTransport(),
    });
    const denied = await revokedPort.execute(
      baseRequest({ kind: 'observe_console' }, 'mtls-denied'),
    );
    expect(denied).toMatchObject({ status: 'REFUSED', mutationAttempted: false });
    expect(execute).toHaveBeenCalledOnce();
  });
});
