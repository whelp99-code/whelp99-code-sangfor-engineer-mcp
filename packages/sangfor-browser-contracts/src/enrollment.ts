import { z } from 'zod';

export * from './enrollment-registry.js';
export * from './enrollment-schemas.js';

export const SCOPED_ENROLLMENT_VERSION = 'browser-postgres-enrollment.v1' as const;
export const CLIENT_AUTH_EKU = '1.3.6.1.5.5.7.3.2' as const;
const idSchema = z.string().trim().min(1).max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@+=/-]*$/u);
export const enrollmentDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const bootstrapTokenSchema = z.string().min(43).max(1024).regex(/^[A-Za-z0-9_-]+$/u);
export const enrollmentInstallationIdSchema = idSchema;
const timestampSchema = z.string().datetime({ offset: true });
const revisionSchema = z.number().int().positive();
const certificatePattern = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu;
const privateKeyPattern = /-----BEGIN[^-]*PRIVATE KEY-----/iu;
const privateMaterialField = /private[_-]?key|passphrase|pkcs8|p12|pfx|certificatePem|csrPem|rawToken/iu;
const pemSchema = z.string().trim().min(1).max(65_536)
  .refine((value) => !privateKeyPattern.test(value), 'Private key material is refused.')
  .refine((value) => {
    const matches = value.match(certificatePattern) ?? [];
    return matches.length === 1 && value.replaceAll(certificatePattern, '').trim().length === 0;
  }, 'Exactly one certificate PEM is required.');
const derSchema = z.string().min(1).max(90_000).regex(/^[A-Za-z0-9+/]+={0,2}$/u);

export const leafCertificateSchema = z.discriminatedUnion('encoding', [
  z.object({ encoding: z.literal('pem'), value: pemSchema }).strict(),
  z.object({ encoding: z.literal('der-base64'), value: derSchema }).strict(),
]).readonly();
export const enrollmentGrantSchema = z.object({
  originDigest: enrollmentDigestSchema,
  scope: idSchema,
}).strict().readonly();
const scopedBindingSchema = z.object({
  tenantId: idSchema,
  projectId: idSchema,
  installationId: idSchema,
  deviceBindingDigest: enrollmentDigestSchema,
}).strict();
const bootstrapIssueFields = {
  expiresAt: timestampSchema,
  grants: z.array(enrollmentGrantSchema).min(1).max(256).readonly(),
} as const;
export const issueBootstrapTokenRequestSchema = scopedBindingSchema.extend(bootstrapIssueFields).strict().readonly();
export const issueBootstrapTokenInputSchema = scopedBindingSchema.extend({
  tokenDigest: enrollmentDigestSchema,
  ...bootstrapIssueFields,
}).strict().superRefine((value, context) => {
  const unique = new Set(value.grants.map(({ originDigest, scope }) => `${originDigest}\0${scope}`));
  if (unique.size !== value.grants.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['grants'], message: 'Duplicate grant.' });
  }
}).readonly();
export const claimBootstrapTokenInputSchema = scopedBindingSchema.extend({
  bootstrapToken: bootstrapTokenSchema,
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
export const certificateAuthorizationInputSchema = scopedBindingSchema.extend({
  originDigest: enrollmentDigestSchema,
  scope: idSchema,
  certificate: leafCertificateSchema,
}).strict().readonly();
export const persistedScopedEnrollmentSchema = scopedBindingSchema.extend({
  schemaVersion: z.literal(SCOPED_ENROLLMENT_VERSION),
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

export type LeafCertificate = z.infer<typeof leafCertificateSchema>;
export type EnrollmentGrant = z.infer<typeof enrollmentGrantSchema>;
export type IssueBootstrapTokenRequest = z.infer<typeof issueBootstrapTokenRequestSchema>;
export type IssueBootstrapTokenInput = z.infer<typeof issueBootstrapTokenInputSchema>;
export type ClaimBootstrapTokenInput = z.infer<typeof claimBootstrapTokenInputSchema>;
export type RotateEnrollmentInput = z.infer<typeof rotateEnrollmentInputSchema>;
export type AcknowledgeRotationInput = z.infer<typeof acknowledgeRotationInputSchema>;
export type RevokeEnrollmentInput = z.infer<typeof revokeEnrollmentInputSchema>;
export type CertificateAuthorizationInput = z.infer<typeof certificateAuthorizationInputSchema>;
export type PersistedScopedEnrollment = z.infer<typeof persistedScopedEnrollmentSchema>;
export type CertificateIdentityRefusal =
  | 'CERTIFICATE_EXPIRED' | 'CERTIFICATE_INVALID' | 'CERTIFICATE_NOT_YET_VALID'
  | 'CLIENT_EKU_MISSING' | 'ISSUER_UNTRUSTED' | 'SAN_MISMATCH';
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
