import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createNodeHttpsTransport,
  createRemoteBrowserExecutionPort,
  createRemoteBrowserJobServer,
  fingerprintsMatch,
  type BrowserExecutionRequest,
} from '../packages/sangfor-browser-contracts/src/index.js';
import {
  remoteTransportEnvelopeOptions,
  remoteTransportIssuedAt,
  remoteTransportPassResult,
  remoteTransportRequest,
} from './helpers/remote-transport-fixture.js';
import { TestRemoteJobStore } from './helpers/remote-job-store-fake.js';

type MtlsFixture = {
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
};

function openssl(args: readonly string[], cwd: string): void {
  execFileSync('openssl', [...args], { cwd, stdio: 'pipe' });
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
    dir, caCert: read('ca.crt'), serverCert, serverKey: read('server.key'),
    serverFingerprint256: new X509Certificate(serverCert).fingerprint256,
    authorizedClientCert, authorizedClientKey: read('client-ok.key'),
    authorizedClientFingerprint256: new X509Certificate(authorizedClientCert).fingerprint256,
    unauthorizedClientCert: read('client-bad.crt'),
    unauthorizedClientKey: read('client-bad.key'),
  };
}

const servers: Array<{ close(): Promise<void> }> = [];
const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Phase 4 remote transport real mTLS', () => {
  it('accepts the pinned client and refuses an unauthorized client before execution', async () => {
    // Given an ephemeral CA, server, and two client certificates.
    const fixture = generateMtlsFixture();
    tempDirs.push(fixture.dir);
    const execute = vi.fn(async (input: BrowserExecutionRequest) => (
      remoteTransportPassResult(input.requestId, { via: 'mtls' })
    ));
    const server = await createRemoteBrowserJobServer({
      host: '127.0.0.1', port: 0,
      tls: { cert: fixture.serverCert, key: fixture.serverKey, ca: fixture.caCert },
      executor: { execute }, jobStore: new TestRemoteJobStore(),
      authorizeClient: (identity) => fingerprintsMatch(
        identity.fingerprint256, fixture.authorizedClientFingerprint256,
      ),
      now: () => remoteTransportIssuedAt,
    });
    servers.push(server);
    const port = (cert: string, key: string) => createRemoteBrowserExecutionPort({
      endpointUrl: server.baseUrl,
      tls: {
        cert, key, ca: fixture.caCert,
        expectedServerFingerprint256: fixture.serverFingerprint256,
        servername: 'localhost',
      },
      envelope: remoteTransportEnvelopeOptions(),
      transport: createNodeHttpsTransport(),
    });

    // When authorized and unauthorized clients each submit a job.
    const accepted = await port(fixture.authorizedClientCert, fixture.authorizedClientKey)
      .execute(remoteTransportRequest({ kind: 'observe_console' }, 'mtls-ok'));
    const refused = await port(fixture.unauthorizedClientCert, fixture.unauthorizedClientKey)
      .execute(remoteTransportRequest({ kind: 'observe_console' }, 'mtls-denied'));

    // Then only the pinned client reaches the executor.
    expect(accepted).toMatchObject({ status: 'PASS', observations: { via: 'mtls' } });
    expect(refused).toMatchObject({ status: 'REFUSED', mutationAttempted: false });
    expect(execute).toHaveBeenCalledOnce();
  });
});
