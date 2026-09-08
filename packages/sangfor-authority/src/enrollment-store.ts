import {
  acknowledgeRotationInputSchema,
  certificateAuthorizationInputSchema,
  claimBootstrapTokenInputSchema,
  issueBootstrapTokenInputSchema,
  rejectSecretEnrollmentFields,
  revokeEnrollmentInputSchema,
  rotateEnrollmentInputSchema,
  type EnrollmentLifecycleDecision,
  type LeafCertificate,
  type PersistedScopedEnrollment,
} from '@sangfor/browser-contracts';
import {
  authorizeEnrollmentSnapshot,
  certificateSnapshotFromRow,
  type EnrollmentAuthorizationDecision,
  type PersistedCertificateRow,
} from './enrollment-authorization.js';
import {
  claimScopedBootstrapToken,
  issueScopedBootstrapToken,
  preflightBootstrapToken,
  type BootstrapTokenDecision,
} from './enrollment-bootstrap.js';
import {
  inEnrollmentScope,
  readScopedEnrollment,
  type EnrollmentClock,
  type EnrollmentDatabase,
  type EnrollmentProjectScope,
} from './enrollment-database.js';
import {
  acknowledgeScopedRotation,
  rotateScopedEnrollment,
  type EnrollmentRepositoryContext,
} from './enrollment-lifecycle.js';
import { revokeScopedEnrollment } from './enrollment-revocation.js';
import {
  deriveClientCertificateIdentity,
  parseTrustedIssuerBundle,
} from './enrollment-x509.js';

export type PostgresEnrollmentRegistryOptions = {
  readonly database: EnrollmentDatabase;
  readonly scope: EnrollmentProjectScope;
  readonly clock?: EnrollmentClock;
  readonly trustedIssuerBundle: string | Buffer;
  readonly certificateIdentityDeriver?: typeof deriveClientCertificateIdentity;
};
export type RepositoryAuthorizationDecision = EnrollmentAuthorizationDecision
  | { readonly ok: false; readonly reason: 'ENROLLMENT_MISSING' };

export class PostgresEnrollmentRegistry {
  private readonly context: EnrollmentRepositoryContext;
  private readonly certificateIdentityDeriver: typeof deriveClientCertificateIdentity;

  constructor(options: PostgresEnrollmentRegistryOptions) {
    this.certificateIdentityDeriver = options.certificateIdentityDeriver ?? deriveClientCertificateIdentity;
    this.context = {
      database: options.database,
      scope: options.scope,
      clock: options.clock ?? { now: () => new Date() },
      trustedIssuers: parseTrustedIssuerBundle(options.trustedIssuerBundle),
    };
  }

  async issueBootstrapToken(input: unknown): Promise<BootstrapTokenDecision> {
    rejectSecretEnrollmentFields(input);
    return issueScopedBootstrapToken(this.context, issueBootstrapTokenInputSchema.parse(input));
  }

  async claimBootstrapToken(input: unknown): Promise<EnrollmentLifecycleDecision> {
    rejectSecretEnrollmentFields(input);
    const parsed = claimBootstrapTokenInputSchema.parse(input);
    if (!this.bindingMatches(parsed)) return { ok: false, reason: 'BINDING_MISMATCH' };
    const preflight = await preflightBootstrapToken(this.context, parsed);
    if (!preflight.ok) return preflight;
    const certificate = this.deriveCertificate(parsed.certificate, parsed);
    if (!certificate.ok) return certificate;
    return claimScopedBootstrapToken(this.context, {
      tenantId: parsed.tenantId,
      projectId: parsed.projectId,
      installationId: parsed.installationId,
      deviceBindingDigest: parsed.deviceBindingDigest,
      clientIdentityId: parsed.clientIdentityId,
      tokenDigest: preflight.tokenDigest,
    }, certificate.certificate);
  }

  async getByInstallation(installationId: string): Promise<PersistedScopedEnrollment | undefined> {
    return inEnrollmentScope(this.context.database, this.context.scope, (transaction) => (
      readScopedEnrollment(transaction, this.context.scope, installationId)
    ));
  }

  async rotate(input: unknown): Promise<EnrollmentLifecycleDecision> {
    rejectSecretEnrollmentFields(input);
    const parsed = rotateEnrollmentInputSchema.parse(input);
    if (!this.bindingMatches(parsed)) return { ok: false, reason: 'BINDING_MISMATCH' };
    const certificate = this.deriveCertificate(parsed.certificate, parsed);
    if (!certificate.ok) return certificate;
    return rotateScopedEnrollment(this.context, { ...parsed, certificate: certificate.certificate });
  }

  async acknowledgeRotation(input: unknown): Promise<EnrollmentLifecycleDecision> {
    rejectSecretEnrollmentFields(input);
    return acknowledgeScopedRotation(this.context, acknowledgeRotationInputSchema.parse(input));
  }

  async revoke(input: unknown): Promise<EnrollmentLifecycleDecision> {
    rejectSecretEnrollmentFields(input);
    return revokeScopedEnrollment(this.context, revokeEnrollmentInputSchema.parse(input));
  }

  async authorize(input: unknown): Promise<RepositoryAuthorizationDecision> {
    rejectSecretEnrollmentFields(input);
    const parsed = certificateAuthorizationInputSchema.parse(input);
    if (!this.bindingMatches(parsed)) return { ok: false, reason: 'ENROLLMENT_MISSING' };
    const presented = this.deriveCertificate(parsed.certificate, parsed);
    if (!presented.ok) return presented;
    return inEnrollmentScope(this.context.database, this.context.scope, async (transaction) => {
      const enrollment = await readScopedEnrollment(transaction, this.context.scope, parsed.installationId);
      if (!enrollment) return { ok: false, reason: 'ENROLLMENT_MISSING' };
      const rows = await transaction.$queryRawUnsafe<readonly PersistedCertificateRow[]>(
        `SELECT c."issuerChainRef",c."issuer",c."subjectAltNames",c."extendedKeyUsages",c."serial",
          c."fingerprintSha256",c."notBefore",c."notAfter",c."state",c."overlapExpiresAt"
         FROM "BlroEnrollmentCertificate" c JOIN "BlroEnrollmentIdentity" e
           ON e."id"=c."enrollmentId" AND e."projectId"=c."projectId"
         WHERE c."projectId"=$1 AND c."serial"=$2 AND e."installationId"=$3`,
        parsed.projectId, presented.certificate.serial, parsed.installationId,
      );
      const row = rows[0];
      if (!row) return { ok: false, reason: 'ENROLLMENT_MISSING' };
      return authorizeEnrollmentSnapshot({
        snapshot: {
          ...enrollment,
          certificate: certificateSnapshotFromRow(row),
          allowedGrants: enrollment.grants,
        },
        request: parsed,
        presentedCertificate: presented.certificate,
        now: this.context.clock.now(),
      });
    });
  }

  private bindingMatches(input: { readonly tenantId: string; readonly projectId: string }): boolean {
    return input.tenantId === this.context.scope.tenantId && input.projectId === this.context.scope.projectId;
  }

  private deriveCertificate(
    certificate: LeafCertificate,
    binding: { readonly installationId: string; readonly deviceBindingDigest: string },
  ) {
    return this.certificateIdentityDeriver({
      certificate,
      trustedIssuers: this.context.trustedIssuers,
      binding,
      now: this.context.clock.now(),
    });
  }
}

export type { BootstrapTokenDecision } from './enrollment-bootstrap.js';
