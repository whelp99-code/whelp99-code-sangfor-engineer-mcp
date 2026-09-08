import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  canonicalizeAllowedOrigin,
  checkServerIdentity,
  parseBlroSanUri,
} from '../packages/sangfor-jm-agent/src/index.js';
import {
  JM_INSTALLATION_ID,
  createJmTlsMaterial,
  type JmTlsMaterial,
} from './helpers/jm-agent-fixture.js';

let root: string;
let tls: JmTlsMaterial;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'jm-agent-'));
  tls = createJmTlsMaterial(root);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('TLS server identity, origin and SAN parsing', () => {
  // openssl stamps notBefore at whole-second granularity, so a wall-clock `now`
  // captured in the same second can fall microseconds BEFORE the certificate
  // becomes valid. Evaluate a minute later: still inside the 10-year window,
  // but never racing the mint boundary.
  const now = new Date(Date.now() + 60_000);

  it('accepts the CA-signed serverAuth loopback leaf that matches its key', () => {
    expect(checkServerIdentity({
      certPath: tls.serverCertPath, keyPath: tls.serverKeyPath, caPath: tls.caPath, now,
    }).ok).toBe(true);
  });

  it('refuses clientAuth-only, non-loopback SAN, foreign CA and key mismatch distinctly', () => {
    const cases = [
      {
        input: { certPath: tls.clientAuthOnlyCertPath, keyPath: tls.clientAuthOnlyKeyPath, caPath: tls.caPath },
        reason: 'SERVER_CERT_EKU_NOT_SERVER_AUTH',
      },
      {
        input: { certPath: tls.nonLoopbackServerCertPath, keyPath: tls.nonLoopbackServerKeyPath, caPath: tls.caPath },
        reason: 'SERVER_CERT_SAN_NOT_LOOPBACK',
      },
      {
        input: { certPath: tls.foreignServerCertPath, keyPath: tls.foreignServerKeyPath, caPath: tls.caPath },
        reason: 'SERVER_CERT_NOT_ISSUED_BY_CA',
      },
      {
        input: { certPath: tls.serverCertPath, keyPath: tls.otherServerKeyPath, caPath: tls.caPath },
        reason: 'SERVER_CERT_KEY_MISMATCH',
      },
    ];

    for (const testCase of cases) {
      const decision = checkServerIdentity({ ...testCase.input, now });
      expect(decision.ok, testCase.reason).toBe(false);
      if (decision.ok) continue;
      expect(decision.reason).toBe(testCase.reason);
    }
  });

  it('canonicalizes allowed origins to https origin only', () => {
    expect(canonicalizeAllowedOrigin('https://a.test')).toBe('https://a.test');
    expect(canonicalizeAllowedOrigin('  https://a.test  ')).toBe('https://a.test');
    // The shared origin contract is origin-ONLY: even a bare trailing slash is a
    // path and is refused, so operators cannot configure two spellings of one origin.
    for (const bad of [
      'https://a.test/', 'https://a.test/path', 'https://a.test/?q=1', 'https://a.test/#f',
      'https://user:pass@a.test', 'http://a.test', 'ftp://a.test', 'not-a-url',
    ]) {
      expect(canonicalizeAllowedOrigin(bad), bad).toBeUndefined();
    }
  });

  it('strictly parses the configured BLRO SAN URI', () => {
    expect(parseBlroSanUri(`urn:sangfor:installation:${JM_INSTALLATION_ID}`))
      .toBe(`urn:sangfor:installation:${JM_INSTALLATION_ID}`);
    for (const bad of [
      'urn:sangfor:installation:', 'urn:sangfor:device:x', 'installation:x',
      'urn:sangfor:installation:a/../b', '',
    ]) {
      expect(parseBlroSanUri(bad), bad).toBeUndefined();
    }
  });
});
