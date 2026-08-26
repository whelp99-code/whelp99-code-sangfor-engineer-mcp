import { z } from 'zod';
import {
  CLIENT_AUTH_EKU,
  leafCertificateSchema,
  type CertificateIdentityRefusal,
  type DerivedClientCertificate,
} from './postgres-enrollment-x509.js';

export const POSTGRES_ENROLLMENT_VERSION = 'browser-postgres-enrollment.v1' as const;
export const MAX_BOOTSTRAP_TTL_MS = 15 * 60 * 1_000;
const idSchema = z.string().trim().min(1).max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@+=/-]*$/u);
export const enrollmentDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const timestampSchema = z.string().datetime({ offset: true });
const revisionSchema = z.number().int().positive();
const privateMaterialField = /private[_-]?key|passphrase|pkcs8|p12|pfx|certificatePem|csrPem|rawToken/iu;

export const enrollmentGrantSchema = z.object({
  originDigest: enrollmentDigestSchema,
  scope: idSchema,
}).strict().readonly();

export const enrollmentCertificateMetadataSchema: z.ZodType<DerivedClientCertificate> = z.object({
  issuerChainRef: enrollmentDigestSchema,
  issuer: z.string().trim().min(1).max(2_000),
  subjectAltNames: z.array(z.string().trim().min(1).max(2_000)).min(2).max(32).readonly(),
  extendedKeyUsages: z.array(idSchema).min(1).max(32).readonly()
    .refine((values) => values.includes(CLIENT_AUTH_EKU), 'Client authentication EKU is required.'),
  serial: idSchema,
  fingerprintSha256: enrollmentDigestSchema,
  notBefore: timestampSchema,
  notAfter: timestampSchema,
}).strict().superRefine((value, context) => {
  if (Date.parse(value.notAfter) <= Date.parse(value.notBefore)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['notAfter'], message: 'notAfter must follow notBefore.' });
  }
}).readonly();

const scopedBindingSchema = z.object({
  tenantId: idSchema,
  projectId: idSchema,
  installationId: idSchema,
  deviceBindingDigest: enrollmentDigestSchema,
}).strict();

export const issueBootstrapTokenInputSchema = scopedBindingSchema.extend({
  tokenDigest: enrollmentDigestSchema,
  expiresAt: timestampSchema,
  grants: z.array(enrollmentGrantSchema).min(1).max(256).readonly(),
}).strict().superRefine((value, context) => {
  const unique = new Set(value.grants.map(({ originDigest, scope }) => `${originDigest}\0${scope}`));
  if (unique.size !== value.grants.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['grants'], message: 'Duplicate grant.' });
  }
}).readonly();

export const claimBootstrapTokenInputSchema = scopedBindingSchema.extend({
  tokenDigest: enrollmentDigestSchema,
  clientIdentityId: idSchema,
  certificate: leafCertificateSchema,
}).strict().readonly();

export const rotateEnrollmentInputSchema = scopedBindingSchema.extend({
  expectedRevision: revisionSchema,
  certificate: leafCertificateSchema,
  overlapExpiresAt: timestampSchema,
}).strict().readonly();

export const acknowledgeRotationInputSchema = scopedBindingSchema.extend({
  expectedRevision: revisionSchema,
  oldSerial: idSchema,
  newSerial: idSchema,
}).strict().readonly();

export const revokeEnrollmentInputSchema = scopedBindingSchema.extend({
  expectedRevision: revisionSchema,
  reason: z.string().trim().min(1).max(500),
}).strict().readonly();

export const persistedScopedEnrollmentSchema = scopedBindingSchema.extend({
  schemaVersion: z.literal(POSTGRES_ENROLLMENT_VERSION),
  clientIdentityId: idSchema,
  state: z.enum(['active', 'revoked']),
  revision: revisionSchema,
  currentCertificateSerial: idSchema,
  grants: z.array(enrollmentGrantSchema).readonly(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  revokedAt: timestampSchema.optional(),
  revocationReason: z.string().trim().min(1).max(500).optional(),
  revocationRevision: revisionSchema.optional(),
}).strict().readonly();

export type EnrollmentGrant = z.infer<typeof enrollmentGrantSchema>;
export type EnrollmentCertificateMetadata = z.infer<typeof enrollmentCertificateMetadataSchema>;
export type IssueBootstrapTokenInput = z.infer<typeof issueBootstrapTokenInputSchema>;
export type ClaimBootstrapTokenInput = z.infer<typeof claimBootstrapTokenInputSchema>;
export type RotateEnrollmentInput = z.infer<typeof rotateEnrollmentInputSchema>;
export type AcknowledgeRotationInput = z.infer<typeof acknowledgeRotationInputSchema>;
export type RevokeEnrollmentInput = z.infer<typeof revokeEnrollmentInputSchema>;
export type PersistedScopedEnrollment = z.infer<typeof persistedScopedEnrollmentSchema>;

export type EnrollmentLifecycleRefusal = CertificateIdentityRefusal
  | 'BINDING_MISMATCH' | 'ENROLLMENT_EXISTS' | 'ENROLLMENT_MISSING'
  | 'ENROLLMENT_REVOKED' | 'REVISION_CONFLICT' | 'ROTATION_INVALID'
  | 'TOKEN_EXPIRED' | 'TOKEN_INVALID' | 'TOKEN_REPLAYED' | 'TOKEN_TTL_EXCEEDED';
export type EnrollmentLifecycleDecision =
  | { readonly ok: true; readonly enrollment: PersistedScopedEnrollment }
  | { readonly ok: false; readonly reason: EnrollmentLifecycleRefusal };

export function rejectSecretEnrollmentFields(input: unknown): void {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return;
  for (const key of Object.keys(input)) {
    if (privateMaterialField.test(key)) throw new EnrollmentBoundaryError(key);
  }
}

export class EnrollmentBoundaryError extends Error {
  override readonly name = 'EnrollmentBoundaryError';
  constructor(readonly field: string) {
    super(`Enrollment persistence refuses secret-bearing field: ${field}`);
  }
}
