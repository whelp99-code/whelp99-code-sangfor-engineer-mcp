import { X509Certificate } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createJmTlsMaterial } from './helpers/jm-agent-fixture.js';

describe('JM agent OpenSSL fixture compatibility', () => {
  it('creates constrained CAs and issued leaves when req rejects custom validity flags', () => {
    // Given: an OpenSSL shim matching releases where `req` cannot set explicit validity windows.
    const root = mkdtempSync(join(tmpdir(), 'jm-openssl-compat-'));
    const originalPath = process.env.PATH;

    try {
      const shimRoot = join(root, 'bin');
      const opensslPath = (process.env.PATH ?? '')
        .split(delimiter)
        .map((directory) => join(directory, 'openssl'))
        .find((candidate) => existsSync(candidate));
      if (opensslPath === undefined) expect.fail('OpenSSL executable not found on PATH.');
      mkdirSync(shimRoot);
      const shimPath = join(shimRoot, 'openssl');
      writeFileSync(shimPath, `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args[0] === 'req' && args.some((arg) => arg === '-not_before' || arg === '-not_after')) {
  process.stderr.write('req validity flags are unsupported\\n');
  process.exit(1);
}
const result = spawnSync(${JSON.stringify(opensslPath)}, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
`);
      chmodSync(shimPath, 0o700);
      process.env.PATH = `${shimRoot}${delimiter}${originalPath ?? ''}`;

      // When: the complete JM TLS fixture is generated through that command set.
      const tls = createJmTlsMaterial(root);

      // Then: explicit CA windows, CA constraints, and leaf issuance remain real.
      const trustedCa = new X509Certificate(readFileSync(tls.caPath));
      const expiredCa = new X509Certificate(readFileSync(tls.expiredCaPath));
      const futureCa = new X509Certificate(readFileSync(tls.futureCaPath));
      const client = new X509Certificate(readFileSync(tls.clientCertPath));
      expect(expiredCa.validFromDate.toISOString()).toBe('2020-01-01T00:00:00.000Z');
      expect(expiredCa.validToDate.toISOString()).toBe('2021-01-01T00:00:00.000Z');
      expect(futureCa.validFromDate.toISOString()).toBe('2040-01-01T00:00:00.000Z');
      expect(futureCa.validToDate.toISOString()).toBe('2041-01-01T00:00:00.000Z');
      expect(trustedCa.ca).toBe(true);
      expect(expiredCa.ca).toBe(true);
      expect(futureCa.ca).toBe(true);
      expect(client.ca).toBe(false);
      expect(client.verify(trustedCa.publicKey)).toBe(true);
    } finally {
      process.env.PATH = originalPath;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
