import { describe, expect, it, vi } from 'vitest';
import {
  EnrollmentRefusedError,
  EnrollmentRegistry,
  assertEnrollmentAllowsJob,
  certificateSigningRequestSchema,
  evaluateEnrollmentForJob,
  maskEnrollmentSecrets,
  parseCertificateSigningRequest,
  toPersistedEnrollmentRecord,
  type CertificateIssuer,
  type CertificateSigningRequest,
  type IssuedCertificateMetadata,
} from '../packages/sangfor-browser-contracts/src/enrollment.js';

const FIXED_NOW = new Date('2026-08-12T16:00:00.000Z');
const LATER = new Date('2026-08-12T17:00:00.000Z');
const PUBLIC_CSR_PEM = [
  '-----BEGIN CERTIFICATE REQUEST-----',
  'MIIBVjCBpubliconly',
  '-----END CERTIFICATE REQUEST-----',
].join('\n');
const PUBLIC_CERT_PEM = [
  '-----BEGIN CERTIFICATE-----',
  'MIIBVjCBpubliccertonly',
  '-----END CERTIFICATE-----',
].join('\n');
const PRIVATE_KEY_PEM = [
  '-----BEGIN PRIVATE KEY-----',
  'MIIEvQIBsecret',
  '-----END PRIVATE KEY-----',
].join('\n');
const FINGERPRINT_A = 'a'.repeat(64);
const FINGERPRINT_B = 'b'.repeat(64);
const FINGERPRINT_C = 'c'.repeat(64);

function csrFor(
  installationId: string,
  fingerprint = FINGERPRINT_A,
): CertificateSigningRequest {
  return certificateSigningRequestSchema.parse({
    schemaVersion: 'browser-csr.v1',
    installationId,
    csrPem: PUBLIC_CSR_PEM,
    publicKeyFingerprintSha256: fingerprint,
    subjectCommonName: installationId,
    requestedAt: FIXED_NOW.toISOString(),
  });
}

function createIssuer(serials = ['serial-1', 'serial-2']): CertificateIssuer & {
  readonly issueFromCsr: ReturnType<typeof vi.fn<CertificateIssuer['issueFromCsr']>>;
} {
  let index = 0;
  const issueFromCsr = vi.fn<CertificateIssuer['issueFromCsr']>(
    ({ now }): IssuedCertificateMetadata => {
      const serial = serials[index] ?? `serial-${index + 1}`;
      index += 1;
      return {
        serial,
        fingerprintSha256: index === 1 ? FINGERPRINT_B : FINGERPRINT_C,
        notBefore: now.toISOString(),
        notAfter: new Date(now.getTime() + 3_600_000).toISOString(),
        certificatePem: PUBLIC_CERT_PEM,
      };
    },
  );
  return { issueFromCsr };
}

function createRegistry(
  issuer: CertificateIssuer = createIssuer(),
  now = FIXED_NOW,
): EnrollmentRegistry {
  return new EnrollmentRegistry(issuer, {
    clock: { now: () => now },
    ids: { clientIdentityId: (installationId) => `client:${installationId}` },
  });
}

describe('BLRO Phase 4 enrollment', () => {
  it('enrolls one identity per installation and refuses duplicate issuance', () => {
    const issuer = createIssuer();
    const registry = createRegistry(issuer);

    const first = registry.enroll(csrFor('install-a'));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.enrollment).toMatchObject({
      schemaVersion: 'browser-enrollment.v1',
      installationId: 'install-a',
      clientIdentityId: 'client:install-a',
      certificateSerial: 'serial-1',
      status: 'active',
    });

    expect(registry.enroll(csrFor('install-a', FINGERPRINT_C))).toMatchObject({
      ok: false,
      reason: 'INSTALLATION_ALREADY_ENROLLED',
    });
    expect(issuer.issueFromCsr).toHaveBeenCalledOnce();
  });

  it('refuses private-key material in CSR and issued certificate metadata', () => {
    expect(() => parseCertificateSigningRequest({
      schemaVersion: 'browser-csr.v1',
      installationId: 'install-a',
      csrPem: PRIVATE_KEY_PEM,
      publicKeyFingerprintSha256: FINGERPRINT_A,
    })).toThrow(/Private-key/);

    const badIssuer: CertificateIssuer = {
      issueFromCsr: () => ({
        serial: 'serial-evil',
        fingerprintSha256: FINGERPRINT_B,
        notBefore: FIXED_NOW.toISOString(),
        notAfter: LATER.toISOString(),
        certificatePem: PRIVATE_KEY_PEM,
      }),
    };
    expect(createRegistry(badIssuer).enroll(csrFor('install-b'))).toMatchObject({
      ok: false,
      reason: 'CERTIFICATE_INVALID',
    });
  });

  it('rotates serials under one identity and supersedes the prior serial', () => {
    const registry = createRegistry(createIssuer(['serial-old', 'serial-new']));
    expect(registry.enroll(csrFor('install-rotate')).ok).toBe(true);

    const rotated = registry.rotate(
      'install-rotate',
      csrFor('install-rotate', FINGERPRINT_C),
    );
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;
    expect(rotated.enrollment).toMatchObject({
      clientIdentityId: 'client:install-rotate',
      certificateSerial: 'serial-new',
      status: 'active',
    });
    expect(registry.getBySerial('serial-old')).toMatchObject({
      status: 'superseded',
      supersededBySerial: 'serial-new',
    });
  });

  it('revokes before job issuance and never calls the issuer again', () => {
    const issuer = createIssuer();
    const registry = createRegistry(issuer);
    expect(registry.enroll(csrFor('install-revoke')).ok).toBe(true);
    expect(registry.revoke('install-revoke', 'endpoint compromised').ok).toBe(true);

    expect(registry.evaluateForJob('install-revoke')).toMatchObject({
      ok: false,
      reason: 'ENROLLMENT_REVOKED',
    });
    expect(() => registry.assertActiveForJob('install-revoke')).toThrow(
      expect.objectContaining<Partial<EnrollmentRefusedError>>({
        name: 'EnrollmentRefusedError',
        reason: 'ENROLLMENT_REVOKED',
      }),
    );
    expect(registry.rotate('install-revoke', csrFor('install-revoke'))).toMatchObject({
      ok: false,
      reason: 'IDENTITY_REVOKED',
    });
    expect(issuer.issueFromCsr).toHaveBeenCalledOnce();
  });

  it('fails closed for missing, early, and expired enrollment', () => {
    const registry = createRegistry();
    expect(registry.evaluateForJob('missing')).toMatchObject({
      ok: false,
      reason: 'ENROLLMENT_MISSING',
    });
    const enrolled = registry.enroll(csrFor('install-time'));
    expect(enrolled.ok).toBe(true);
    if (!enrolled.ok) return;

    expect(evaluateEnrollmentForJob(
      enrolled.enrollment,
      new Date(FIXED_NOW.getTime() - 1),
    )).toMatchObject({ ok: false, reason: 'ENROLLMENT_NOT_YET_VALID' });
    expect(evaluateEnrollmentForJob(
      enrolled.enrollment,
      new Date(FIXED_NOW.getTime() + 3_600_000),
    )).toMatchObject({ ok: false, reason: 'ENROLLMENT_EXPIRED' });
    expect(() => assertEnrollmentAllowsJob(undefined, FIXED_NOW))
      .toThrow(EnrollmentRefusedError);
  });

  it('persists metadata only and masks private-key material recursively', () => {
    const registry = createRegistry();
    const enrolled = registry.enroll(csrFor('install-persist'));
    expect(enrolled.ok).toBe(true);
    if (!enrolled.ok) return;

    const persisted = toPersistedEnrollmentRecord(enrolled.enrollment);
    expect(persisted).not.toHaveProperty('certificatePem');
    expect(persisted).not.toHaveProperty('csrPem');
    expect(JSON.stringify(persisted)).not.toMatch(/PRIVATE KEY/i);

    expect(maskEnrollmentSecrets({
      privateKeyPem: PRIVATE_KEY_PEM,
      nested: { note: PRIVATE_KEY_PEM },
    })).toEqual({
      privateKeyPem: '***',
      nested: { note: '***' },
    });
  });
});
