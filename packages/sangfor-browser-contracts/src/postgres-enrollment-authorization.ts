import { z } from 'zod';
import {
  enrollmentDigestSchema,
  type PersistedScopedEnrollment,
} from './postgres-enrollment-schemas.js';
import {
  leafCertificateSchema,
  type CertificateIdentityRefusal,
  type DerivedClientCertificate,
} from './postgres-enrollment-x509.js';

const identitySchema = z.string().trim().min(1).max(200);
export const certificateAuthorizationInputSchema = z.object({
  tenantId: identitySchema,
  projectId: identitySchema,
  installationId: identitySchema,
  deviceBindingDigest: enrollmentDigestSchema,
  originDigest: enrollmentDigestSchema,
  scope: identitySchema,
  certificate: leafCertificateSchema,
}).strict().readonly();

export type CertificateAuthorizationInput = z.infer<typeof certificateAuthorizationInputSchema>;
export type EnrollmentCertificateSnapshot = DerivedClientCertificate & {
  readonly state: 'active' | 'overlap' | 'revoked' | 'superseded';
  readonly overlapExpiresAt?: string;
};
export type PersistedCertificateRow = {
  readonly issuerChainRef: string;
  readonly issuer: string;
  readonly subjectAltNames: readonly string[];
  readonly extendedKeyUsages: readonly string[];
  readonly serial: string;
  readonly fingerprintSha256: string;
  readonly notBefore: Date;
  readonly notAfter: Date;
  readonly state: EnrollmentCertificateSnapshot['state'];
  readonly overlapExpiresAt: Date | null;
};
export type EnrollmentAuthorizationSnapshot = Pick<
  PersistedScopedEnrollment,
  'tenantId' | 'projectId' | 'installationId' | 'deviceBindingDigest' | 'state' | 'revision'
> & {
  readonly certificate: EnrollmentCertificateSnapshot;
  readonly allowedGrants: readonly { readonly originDigest: string; readonly scope: string }[];
};
export type EnrollmentAuthorizationRefusal = CertificateIdentityRefusal
  | 'CERTIFICATE_REVOKED' | 'DEVICE_BINDING_MISMATCH' | 'ENROLLMENT_REVOKED' | 'FINGERPRINT_MISMATCH'
  | 'INSTALLATION_MISMATCH' | 'ISSUER_MISMATCH' | 'ISSUER_UNTRUSTED'
  | 'ORIGIN_NOT_GRANTED' | 'ROTATION_OVERLAP_EXPIRED' | 'SAN_MISMATCH'
  | 'SCOPE_MISMATCH' | 'SCOPE_NOT_GRANTED' | 'SERIAL_MISMATCH' | 'VALIDITY_MISMATCH';
export type EnrollmentAuthorizationDecision =
  | { readonly ok: true; readonly revision: number }
  | { readonly ok: false; readonly reason: EnrollmentAuthorizationRefusal };
export type EnrollmentAuthorizationContext = {
  readonly snapshot: EnrollmentAuthorizationSnapshot;
  readonly request: CertificateAuthorizationInput;
  readonly presentedCertificate: DerivedClientCertificate;
  readonly now: Date;
};

const refused = (reason: EnrollmentAuthorizationRefusal): EnrollmentAuthorizationDecision => ({ ok: false, reason });
export function certificateSnapshotFromRow(row: PersistedCertificateRow): EnrollmentCertificateSnapshot {
  return {
    issuerChainRef: row.issuerChainRef, issuer: row.issuer, subjectAltNames: row.subjectAltNames,
    extendedKeyUsages: row.extendedKeyUsages, serial: row.serial,
    fingerprintSha256: row.fingerprintSha256, state: row.state,
    notBefore: row.notBefore.toISOString(), notAfter: row.notAfter.toISOString(),
    ...(row.overlapExpiresAt ? { overlapExpiresAt: row.overlapExpiresAt.toISOString() } : {}),
  };
}

export function authorizeEnrollmentSnapshot(
  context: EnrollmentAuthorizationContext,
): EnrollmentAuthorizationDecision {
  const { snapshot, request, presentedCertificate: presented, now } = context;
  if (snapshot.tenantId !== request.tenantId || snapshot.projectId !== request.projectId) return refused('SCOPE_MISMATCH');
  if (snapshot.installationId !== request.installationId) return refused('INSTALLATION_MISMATCH');
  if (snapshot.deviceBindingDigest !== request.deviceBindingDigest) return refused('DEVICE_BINDING_MISMATCH');
  if (snapshot.state === 'revoked') return refused('ENROLLMENT_REVOKED');
  const stored = snapshot.certificate;
  if (stored.issuerChainRef !== presented.issuerChainRef) return refused('ISSUER_UNTRUSTED');
  if (stored.issuer !== presented.issuer) return refused('ISSUER_MISMATCH');
  if (stored.subjectAltNames.length !== presented.subjectAltNames.length
    || !stored.subjectAltNames.every((san) => presented.subjectAltNames.includes(san))) return refused('SAN_MISMATCH');
  if (stored.serial !== presented.serial) return refused('SERIAL_MISMATCH');
  if (stored.fingerprintSha256 !== presented.fingerprintSha256) return refused('FINGERPRINT_MISMATCH');
  if (Date.parse(stored.notBefore) !== Date.parse(presented.notBefore)
    || Date.parse(stored.notAfter) !== Date.parse(presented.notAfter)) return refused('VALIDITY_MISMATCH');
  const nowMs = now.getTime();
  if (nowMs < Date.parse(stored.notBefore)) return refused('CERTIFICATE_NOT_YET_VALID');
  if (nowMs >= Date.parse(stored.notAfter)) return refused('CERTIFICATE_EXPIRED');
  if (stored.state === 'revoked' || stored.state === 'superseded') return refused('CERTIFICATE_REVOKED');
  if (stored.state === 'overlap'
    && (!stored.overlapExpiresAt || nowMs >= Date.parse(stored.overlapExpiresAt))) {
    return refused('ROTATION_OVERLAP_EXPIRED');
  }
  const originGranted = snapshot.allowedGrants.some(({ originDigest }) => originDigest === request.originDigest);
  if (!originGranted) return refused('ORIGIN_NOT_GRANTED');
  if (!snapshot.allowedGrants.some(({ originDigest, scope }) => (
    originDigest === request.originDigest && scope === request.scope
  ))) return refused('SCOPE_NOT_GRANTED');
  return { ok: true, revision: snapshot.revision };
}
