import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface RemoteMtlsFixture {
  readonly dir: string;
  readonly caCert: string;
  readonly serverCert: string;
  readonly serverKey: string;
  readonly authorizedClientCert: string;
  readonly authorizedClientKey: string;
  readonly authorizedClientFingerprint256: string;
  readonly revokedClientCert: string;
  readonly revokedClientKey: string;
  readonly rogueClientCert: string;
  readonly rogueClientKey: string;
  readonly remove: () => void;
}

function openssl(args: readonly string[], cwd: string): void {
  execFileSync('openssl', args, { cwd, stdio: 'pipe' });
}

export function generateRemoteMtlsFixture(): RemoteMtlsFixture {
  const dir = mkdtempSync(join(tmpdir(), 'remote-mtls-'));
  openssl([
    'req', '-x509', '-newkey', 'rsa:2048', '-keyout', 'ca.key', '-out', 'ca.crt',
    '-days', '1', '-nodes', '-subj', '/CN=Remote-Test-CA',
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
  for (const [name, commonName] of [
    ['client-ok', 'remote-authorized'],
    ['client-revoked', 'remote-revoked'],
  ] as const) {
    openssl([
      'req', '-newkey', 'rsa:2048', '-keyout', `${name}.key`, '-out', `${name}.csr`,
      '-nodes', '-subj', `/CN=${commonName}`,
    ], dir);
    openssl([
      'x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key',
      '-CAcreateserial', '-out', `${name}.crt`, '-days', '1',
    ], dir);
  }
  openssl([
    'req', '-x509', '-newkey', 'rsa:2048', '-keyout', 'client-rogue.key',
    '-out', 'client-rogue.crt', '-days', '1', '-nodes', '-subj', '/CN=remote-rogue',
  ], dir);
  const read = (name: string): string => readFileSync(join(dir, name), 'utf8');
  const authorizedClientCert = read('client-ok.crt');
  return {
    dir,
    caCert: read('ca.crt'),
    serverCert: read('server.crt'),
    serverKey: read('server.key'),
    authorizedClientCert,
    authorizedClientKey: read('client-ok.key'),
    authorizedClientFingerprint256:
      new X509Certificate(authorizedClientCert).fingerprint256,
    revokedClientCert: read('client-revoked.crt'),
    revokedClientKey: read('client-revoked.key'),
    rogueClientCert: read('client-rogue.crt'),
    rogueClientKey: read('client-rogue.key'),
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}
