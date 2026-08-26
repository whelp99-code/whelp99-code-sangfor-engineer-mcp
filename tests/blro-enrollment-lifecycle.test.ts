import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CLIENT_AUTH_EKU,
  certificateAuthorizationInputSchema,
  claimBootstrapTokenInputSchema,
  deriveClientCertificateIdentity,
  parseTrustedIssuerBundle,
} from '../packages/sangfor-browser-contracts/src/enrollment.js';
import {
  createTaskCertificateFixture,
  type TaskCertificateFixture,
} from './helpers/blro-certificate-fixture.js';

const NOW = new Date('2026-08-26T12:00:00.000Z');
const installationId = 'install-a';
const deviceBindingDigest = 'd'.repeat(64);
let root: string;
let fixture: TaskCertificateFixture;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'task21-x509-'));
  fixture = createTaskCertificateFixture(root, installationId, deviceBindingDigest);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const derive = (certificate: { readonly encoding: 'pem' | 'der-base64'; readonly value: string }) => (
  deriveClientCertificateIdentity({
    certificate,
    trustedIssuers: parseTrustedIssuerBundle(fixture.trustedCaPem),
    binding: { installationId, deviceBindingDigest },
    now: NOW,
  })
);

describe('BLRO enrollment X.509 authority', () => {
  it('derives certificate identity from signed PEM or DER without caller metadata', () => {
    const pem = derive({ encoding: 'pem', value: fixture.validPem });
    const der = derive({ encoding: 'der-base64', value: fixture.validDerBase64 });

    expect(pem).toMatchObject({
      ok: true,
      certificate: {
        extendedKeyUsages: expect.arrayContaining([CLIENT_AUTH_EKU]),
        subjectAltNames: expect.arrayContaining([
          `urn:sangfor:installation:${installationId}`,
          `urn:sangfor:device-sha256:${deviceBindingDigest}`,
        ]),
      },
    });
    expect(der).toEqual(pem);
  });

  it.each([
    ['foreign issuer', () => fixture.foreignPem, 'ISSUER_UNTRUSTED'],
    ['unsigned self-signed leaf', () => fixture.unsignedPem, 'ISSUER_UNTRUSTED'],
    ['CN only', () => fixture.cnOnlyPem, 'SAN_MISMATCH'],
    ['wrong EKU', () => fixture.wrongEkuPem, 'CLIENT_EKU_MISSING'],
    ['expired', () => fixture.expiredPem, 'CERTIFICATE_EXPIRED'],
    ['future', () => fixture.futurePem, 'CERTIFICATE_NOT_YET_VALID'],
  ] as const)('refuses %s certificates cryptographically', (_case, pem, reason) => {
    expect(derive({ encoding: 'pem', value: pem() })).toEqual({ ok: false, reason });
  });

  it('binds signed SANs to the exact installation and device digest', () => {
    const trustedIssuers = parseTrustedIssuerBundle(fixture.trustedCaPem);
    for (const binding of [
      { installationId: 'install-b', deviceBindingDigest },
      { installationId, deviceBindingDigest: 'e'.repeat(64) },
    ]) {
      expect(deriveClientCertificateIdentity({
        certificate: { encoding: 'pem', value: fixture.validPem },
        trustedIssuers, binding, now: NOW,
      })).toEqual({ ok: false, reason: 'SAN_MISMATCH' });
    }
  });

  it('refuses caller-asserted identity fields even when they mimic a trusted certificate', () => {
    const legacyMetadata = {
      issuerChainRef: 'trusted', issuer: 'CN=Task-21-Trusted-CA', serial: '1000',
      fingerprintSha256: 'a'.repeat(64), subjectAltName: `urn:sangfor:installation:${installationId}`,
      extendedKeyUsages: [CLIENT_AUTH_EKU], notBefore: NOW.toISOString(),
      notAfter: '2026-08-27T00:00:00.000Z',
    };
    expect(() => claimBootstrapTokenInputSchema.parse({
      tenantId: 'tenant-a', projectId: 'project-a', installationId, deviceBindingDigest,
      tokenDigest: 'b'.repeat(64), clientIdentityId: 'client-a', certificate: legacyMetadata,
    })).toThrow();
    expect(() => certificateAuthorizationInputSchema.parse({
      tenantId: 'tenant-a', projectId: 'project-a', installationId, deviceBindingDigest,
      originDigest: 'c'.repeat(64), scope: 'browser:execute', certificate: legacyMetadata,
    })).toThrow();
  });
});
