import { z } from 'zod';

export const ENROLLMENT_RECORD_VERSION = 'browser-enrollment.v1' as const;
export const CSR_SCHEMA_VERSION = 'browser-csr.v1' as const;

const opaqueIdSchema = z.string().trim().min(1).max(200)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:@+=-]*$/u,
    'Opaque value must not contain path separators or whitespace.',
  )
  .refine((value) => !value.includes('..'), 'Opaque value must not contain path traversal segments.');
const timestampSchema = z.string().datetime({ offset: true });
const fingerprintSchema = z.string().regex(
  /^[a-f0-9]{64}$/u,
  'Fingerprint must be lowercase sha256 hex.',
);
const PRIVATE_KEY_PEM_RE = /-----BEGIN[^-]*PRIVATE KEY-----/iu;
const SECRET_FIELD_RE = /private[_-]?key|passphrase|pkcs8|p12|pfx/iu;
const publicPemSchema = z.string().trim().min(1).max(32_768)
  .refine((value) => !PRIVATE_KEY_PEM_RE.test(value), 'Private-key PEM material is refused.');

export const certificateSigningRequestSchema = z.object({
  schemaVersion: z.literal(CSR_SCHEMA_VERSION),
  installationId: opaqueIdSchema,
  csrPem: publicPemSchema,
  publicKeyFingerprintSha256: fingerprintSchema,
  subjectCommonName: opaqueIdSchema.optional(),
  requestedAt: timestampSchema.optional(),
}).strict().readonly();

export const issuedCertificateMetadataSchema = z.object({
  serial: opaqueIdSchema,
  fingerprintSha256: fingerprintSchema,
  notBefore: timestampSchema,
  notAfter: timestampSchema,
  certificatePem: publicPemSchema.optional(),
}).strict().superRefine((certificate, context) => {
  if (Date.parse(certificate.notAfter) <= Date.parse(certificate.notBefore)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['notAfter'],
      message: 'Certificate notAfter must be after notBefore.',
    });
  }
}).readonly();

export const enrollmentStatusSchema = z.enum(['active', 'revoked', 'superseded']);
export const clientEnrollmentSchema = z.object({
  schemaVersion: z.literal(ENROLLMENT_RECORD_VERSION),
  installationId: opaqueIdSchema,
  clientIdentityId: opaqueIdSchema,
  certificateSerial: opaqueIdSchema,
  publicKeyFingerprintSha256: fingerprintSchema,
  certificateFingerprintSha256: fingerprintSchema,
  status: enrollmentStatusSchema,
  enrolledAt: timestampSchema,
  notBefore: timestampSchema,
  notAfter: timestampSchema,
  revokedAt: timestampSchema.optional(),
  revocationReason: z.string().trim().min(1).max(500).optional(),
  supersededBySerial: opaqueIdSchema.optional(),
}).strict().readonly();

export const persistedEnrollmentRecordSchema = clientEnrollmentSchema;

export type CertificateSigningRequest = z.infer<typeof certificateSigningRequestSchema>;
export type IssuedCertificateMetadata = z.infer<typeof issuedCertificateMetadataSchema>;
export type ClientEnrollment = z.infer<typeof clientEnrollmentSchema>;
export type PersistedEnrollmentRecord = z.infer<typeof persistedEnrollmentRecordSchema>;
export type EnrollmentRefusalReason =
  | 'CERTIFICATE_INVALID'
  | 'CSR_INVALID'
  | 'ENROLLMENT_EXPIRED'
  | 'ENROLLMENT_MISSING'
  | 'ENROLLMENT_NOT_YET_VALID'
  | 'ENROLLMENT_REVOKED'
  | 'ENROLLMENT_SUPERSEDED'
  | 'IDENTITY_REVOKED'
  | 'INSTALLATION_ALREADY_ENROLLED'
  | 'INSTALLATION_MISMATCH';
export type EnrollmentDecision =
  | { readonly ok: true; readonly enrollment: ClientEnrollment }
  | {
    readonly ok: false;
    readonly reason: EnrollmentRefusalReason;
    readonly message: string;
  };

export class EnrollmentRefusedError extends Error {
  override readonly name = 'EnrollmentRefusedError';

  constructor(
    readonly reason: EnrollmentRefusalReason,
    message: string,
  ) {
    super(message);
  }
}

export function denyEnrollment(
  reason: EnrollmentRefusalReason,
  message: string,
): Extract<EnrollmentDecision, { readonly ok: false }> {
  return { ok: false, reason, message };
}

export function parseCsrOrDeny(
  input: unknown,
): CertificateSigningRequest | Extract<EnrollmentDecision, { readonly ok: false }> {
  const parsed = certificateSigningRequestSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  return denyEnrollment(
    'CSR_INVALID',
    parsed.error.issues[0]?.message ?? 'CSR invalid.',
  );
}

export function parseCertificateSigningRequest(input: unknown): CertificateSigningRequest {
  return certificateSigningRequestSchema.parse(input);
}

export function evaluateEnrollmentForJob(
  enrollment: ClientEnrollment | undefined,
  now: Date,
): EnrollmentDecision {
  if (!enrollment) {
    return denyEnrollment(
      'ENROLLMENT_MISSING',
      'No enrolled client identity for this installation.',
    );
  }
  if (enrollment.status === 'revoked') {
    return denyEnrollment(
      'ENROLLMENT_REVOKED',
      `Client identity ${enrollment.clientIdentityId} is revoked.`,
    );
  }
  if (enrollment.status === 'superseded') {
    return denyEnrollment(
      'ENROLLMENT_SUPERSEDED',
      `Certificate serial ${enrollment.certificateSerial} was superseded.`,
    );
  }
  const nowMs = now.getTime();
  if (nowMs < Date.parse(enrollment.notBefore)) {
    return denyEnrollment(
      'ENROLLMENT_NOT_YET_VALID',
      'Enrollment certificate is not yet valid.',
    );
  }
  if (nowMs >= Date.parse(enrollment.notAfter)) {
    return denyEnrollment(
      'ENROLLMENT_EXPIRED',
      'Enrollment certificate has expired.',
    );
  }
  return { ok: true, enrollment };
}

export function assertEnrollmentAllowsJob(
  enrollment: ClientEnrollment | undefined,
  now: Date,
): ClientEnrollment {
  const decision = evaluateEnrollmentForJob(enrollment, now);
  if (!decision.ok) {
    throw new EnrollmentRefusedError(decision.reason, decision.message);
  }
  return decision.enrollment;
}

export function toPersistedEnrollmentRecord(
  enrollment: ClientEnrollment,
): PersistedEnrollmentRecord {
  return persistedEnrollmentRecordSchema.parse({
    schemaVersion: enrollment.schemaVersion,
    installationId: enrollment.installationId,
    clientIdentityId: enrollment.clientIdentityId,
    certificateSerial: enrollment.certificateSerial,
    publicKeyFingerprintSha256: enrollment.publicKeyFingerprintSha256,
    certificateFingerprintSha256: enrollment.certificateFingerprintSha256,
    status: enrollment.status,
    enrolledAt: enrollment.enrolledAt,
    notBefore: enrollment.notBefore,
    notAfter: enrollment.notAfter,
    ...(enrollment.revokedAt ? { revokedAt: enrollment.revokedAt } : {}),
    ...(enrollment.revocationReason
      ? { revocationReason: enrollment.revocationReason }
      : {}),
    ...(enrollment.supersededBySerial
      ? { supersededBySerial: enrollment.supersededBySerial }
      : {}),
  });
}

export function maskEnrollmentSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskEnrollmentSecrets);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      SECRET_FIELD_RE.test(key)
        || (typeof child === 'string' && PRIVATE_KEY_PEM_RE.test(child))
        ? '***'
        : maskEnrollmentSecrets(child),
    ]));
  }
  return typeof value === 'string' && PRIVATE_KEY_PEM_RE.test(value) ? '***' : value;
}
