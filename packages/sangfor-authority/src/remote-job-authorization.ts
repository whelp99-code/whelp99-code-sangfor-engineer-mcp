import type {
  BrowserExecutionRequest,
  JobCapabilityClaim,
  LeafCertificate,
} from '@sangfor/browser-contracts';
import {
  CanonicalOriginError,
  digestCanonicalOrigin,
} from '@sangfor/shared';
import {
  authorizeEnrollmentSnapshot,
  certificateSnapshotFromRow,
  type PersistedCertificateRow,
} from './enrollment-authorization.js';
import type {
  EnrollmentProjectScope,
  EnrollmentSqlExecutor,
} from './enrollment-database.js';
import {
  deriveClientCertificateIdentity,
  type TrustedIssuer,
} from './enrollment-x509.js';

export const REMOTE_BROWSER_EXECUTION_SCOPE = 'browser:execute' as const;

type EnrollmentIdentityRow = {
  readonly tenantId: string;
  readonly projectId: string;
  readonly installationId: string;
  readonly deviceBindingDigest: string;
  readonly clientIdentityId: string;
  readonly state: 'active' | 'revoked';
  readonly revision: number;
};
type GrantRow = {
  readonly originDigest: string;
  readonly scope: string;
};
export type RemoteTargetAuthorizationInput = {
  readonly transaction: EnrollmentSqlExecutor;
  readonly scope: EnrollmentProjectScope;
  readonly installationId: string;
  readonly clientIdentityId: string;
  readonly origin: string;
  readonly certificate: LeafCertificate;
  readonly trustedIssuers: readonly TrustedIssuer[];
  readonly now: Date;
};

export async function authorizeRemoteTarget(
  input: RemoteTargetAuthorizationInput,
): Promise<boolean> {
  const enrollments = await input.transaction.$queryRawUnsafe<readonly EnrollmentIdentityRow[]>(
    `SELECT "tenantId","projectId","installationId","deviceBindingDigest",
      "clientIdentityId","state","revision"
     FROM "BlroEnrollmentIdentity"
     WHERE "tenantId"=$1 AND "projectId"=$2 AND "installationId"=$3
     FOR SHARE`,
    input.scope.tenantId,
    input.scope.projectId,
    input.installationId,
  );
  const enrollment = enrollments[0];
  if (!enrollment || enrollment.clientIdentityId !== input.clientIdentityId) return false;
  const presented = deriveClientCertificateIdentity({
    certificate: input.certificate,
    trustedIssuers: input.trustedIssuers,
    binding: {
      installationId: enrollment.installationId,
      deviceBindingDigest: enrollment.deviceBindingDigest,
    },
    now: input.now,
  });
  if (!presented.ok) return false;
  const certificates = await input.transaction.$queryRawUnsafe<readonly PersistedCertificateRow[]>(
    `SELECT "issuerChainRef","issuer","subjectAltNames","extendedKeyUsages","serial",
      "fingerprintSha256","notBefore","notAfter","state","overlapExpiresAt"
     FROM "BlroEnrollmentCertificate"
     WHERE "tenantId"=$1 AND "projectId"=$2 AND "enrollmentId"=(
       SELECT "id" FROM "BlroEnrollmentIdentity"
       WHERE "projectId"=$2 AND "installationId"=$3
     ) AND "serial"=$4`,
    input.scope.tenantId,
    input.scope.projectId,
    input.installationId,
    presented.certificate.serial,
  );
  const certificate = certificates[0];
  if (!certificate) return false;
  const grants = await input.transaction.$queryRawUnsafe<readonly GrantRow[]>(
    `SELECT "originDigest","scope" FROM "BlroEnrollmentGrant"
     WHERE "tenantId"=$1 AND "projectId"=$2 AND "enrollmentId"=(
       SELECT "id" FROM "BlroEnrollmentIdentity"
       WHERE "projectId"=$2 AND "installationId"=$3
     ) ORDER BY "originDigest","scope"`,
    input.scope.tenantId,
    input.scope.projectId,
    input.installationId,
  );
  let originDigest: string;
  try {
    originDigest = digestCanonicalOrigin(input.origin, 'origin');
  } catch (error) {
    if (error instanceof CanonicalOriginError) return false;
    throw error;
  }
  return authorizeEnrollmentSnapshot({
    snapshot: {
      ...enrollment,
      certificate: certificateSnapshotFromRow(certificate),
      allowedGrants: grants,
    },
    request: {
      tenantId: input.scope.tenantId,
      projectId: input.scope.projectId,
      installationId: input.installationId,
      deviceBindingDigest: enrollment.deviceBindingDigest,
      originDigest,
      scope: REMOTE_BROWSER_EXECUTION_SCOPE,
      certificate: input.certificate,
    },
    presentedCertificate: presented.certificate,
    now: input.now,
  }).ok;
}

export type RemoteJobAuthorizationInput = {
  readonly transaction: EnrollmentSqlExecutor;
  readonly scope: EnrollmentProjectScope;
  readonly claim: JobCapabilityClaim;
  readonly request: BrowserExecutionRequest;
  readonly certificate: LeafCertificate;
  readonly trustedIssuers: readonly TrustedIssuer[];
  readonly now: Date;
};

export function authorizeRemoteJob(input: RemoteJobAuthorizationInput): Promise<boolean> {
  return authorizeRemoteTarget({
    transaction: input.transaction,
    scope: input.scope,
    installationId: input.claim.installationId,
    clientIdentityId: input.claim.clientIdentityId,
    origin: input.request.origin,
    certificate: input.certificate,
    trustedIssuers: input.trustedIssuers,
    now: input.now,
  });
}
