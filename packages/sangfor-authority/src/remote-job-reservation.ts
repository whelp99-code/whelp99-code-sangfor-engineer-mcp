import type {
  JobCapabilityClaim,
  JobEnvelope,
  LeafCertificate,
  RemoteJobDispatch,
  RemoteJobReservation,
} from '@sangfor/browser-contracts';
import {
  REMOTE_JOB_REFUSAL_REASONS,
} from '@sangfor/browser-contracts';
import { authorizeRemoteJob } from './remote-job-authorization.js';
import type {
  EnrollmentProjectScope,
  EnrollmentSqlExecutor,
} from './enrollment-database.js';
import type { TrustedIssuer } from './enrollment-x509.js';
import {
  reservationFromRemoteJobRow,
  type RemoteJobRow,
} from './remote-job-result.js';

export type ReserveRemoteJobTransactionInput = {
  readonly transaction: EnrollmentSqlExecutor;
  readonly scope: EnrollmentProjectScope;
  readonly claim: JobCapabilityClaim;
  readonly envelope: JobEnvelope;
  readonly certificate: LeafCertificate;
  readonly trustedIssuers: readonly TrustedIssuer[];
  readonly requestDigest: string;
  readonly dispatchId: string;
  readonly now: Date;
};

export class RemoteJobReservationRollback extends Error {
  override readonly name = 'RemoteJobReservationRollback';
  constructor(readonly reservation: RemoteJobReservation) {
    super('Remote job reservation requires transaction rollback.');
  }
}

export async function reserveRemoteJobTransaction(
  input: ReserveRemoteJobTransactionInput,
): Promise<RemoteJobReservation> {
  await input.transaction.$executeRawUnsafe(
    `INSERT INTO "BlroProjectAuthorityEpoch" ("projectId","epoch","revision") SELECT "id",0,0 FROM "BlroProject" WHERE "id"=$1 ON CONFLICT DO NOTHING`, input.scope.projectId,
  );
  const epochs = await input.transaction.$queryRawUnsafe<readonly { readonly epoch: number }[]>(
    `SELECT "epoch" FROM "BlroProjectAuthorityEpoch" WHERE "projectId"=$1 FOR SHARE`, input.scope.projectId,
  );
  if (epochs[0]?.epoch !== input.claim.authorityEpoch) return authorizationRefused();
  const authorized = await authorizeRemoteJob({
    transaction: input.transaction,
    scope: input.scope,
    claim: input.claim,
    request: input.envelope.request,
    certificate: input.certificate,
    trustedIssuers: input.trustedIssuers,
    now: input.now,
  });
  if (!authorized) return authorizationRefused();
  await input.transaction.$executeRawUnsafe(
    `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
    JSON.stringify([
      input.scope.tenantId,
      input.scope.projectId,
      input.claim.installationId,
      input.envelope.jobId,
    ]),
  );
  const consumed = await input.transaction.$queryRawUnsafe<readonly { readonly jti: string }[]>(
    `INSERT INTO "BlroRemoteJobCapabilityJti"
      ("jti","tenantId","projectId","installationId","jobId","requestDigest",
       "capabilityExpiresAt","consumedAt")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT DO NOTHING RETURNING "jti"`,
    input.claim.jti,
    input.scope.tenantId,
    input.scope.projectId,
    input.claim.installationId,
    input.envelope.jobId,
    input.requestDigest,
    new Date(input.claim.expiresAt),
    input.now,
  );
  if (!consumed[0]) return authorizationRefused();
  const existing = await readExistingRemoteJob(input);
  if (existing) throw new RemoteJobReservationRollback(decisionFromExisting(existing, input.requestDigest));
  const inserted = await input.transaction.$queryRawUnsafe<readonly { readonly id: string }[]>(
    `INSERT INTO "BlroRemoteJob"
      ("id","tenantId","projectId","installationId","jobId","runId","stepId",
       "requestId","requestDigest","capabilityJti","state","tombstoneCommittedAt",
       "createdAt","updatedAt","authorityEpoch")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'dispatch_committed',$11,$11,$11,$12)
     ON CONFLICT DO NOTHING RETURNING "id"`,
    input.dispatchId,
    input.scope.tenantId,
    input.scope.projectId,
    input.claim.installationId,
    input.envelope.jobId,
    input.envelope.runId,
    input.envelope.stepId,
    input.envelope.request.requestId,
    input.requestDigest,
    input.claim.jti,
    input.now,
    input.claim.authorityEpoch,
  );
  if (inserted[0]) return { kind: 'dispatch', dispatch: dispatchFrom(input) };
  const concurrent = await readExistingRemoteJob(input);
  if (!concurrent) throw new RemoteJobReservationConsistencyError();
  throw new RemoteJobReservationRollback(decisionFromExisting(concurrent, input.requestDigest));
}

async function readExistingRemoteJob(
  input: ReserveRemoteJobTransactionInput,
): Promise<RemoteJobRow | undefined> {
  const rows = await input.transaction.$queryRawUnsafe<readonly RemoteJobRow[]>(
    `SELECT "id","tenantId","projectId","installationId","jobId","requestId",
      "requestDigest","capabilityJti","authorityEpoch","state","result","resultDigest"
     FROM "BlroRemoteJob"
     WHERE "tenantId"=$1 AND "projectId"=$2 AND "installationId"=$3 AND "jobId"=$4 AND "authorityEpoch"=$5`,
    input.scope.tenantId,
    input.scope.projectId,
    input.claim.installationId,
    input.envelope.jobId,
    input.claim.authorityEpoch,
  );
  return rows[0];
}

function decisionFromExisting(row: RemoteJobRow, requestDigest: string): RemoteJobReservation {
  return row.requestDigest === requestDigest
    ? reservationFromRemoteJobRow(row)
    : { kind: 'refused', reason: REMOTE_JOB_REFUSAL_REASONS.REQUEST_CONFLICT };
}

function dispatchFrom(input: ReserveRemoteJobTransactionInput): RemoteJobDispatch {
  return {
    dispatchId: input.dispatchId,
    tenantId: input.scope.tenantId,
    projectId: input.scope.projectId,
    authorityEpoch: input.claim.authorityEpoch,
    installationId: input.claim.installationId,
    jobId: input.envelope.jobId,
    requestId: input.envelope.request.requestId,
    requestDigest: input.requestDigest,
    capabilityJti: input.claim.jti,
  };
}

function authorizationRefused(): RemoteJobReservation {
  return { kind: 'refused', reason: REMOTE_JOB_REFUSAL_REASONS.AUTHORIZATION_REFUSED };
}

class RemoteJobReservationConsistencyError extends Error {
  override readonly name = 'RemoteJobReservationConsistencyError';
  constructor() {
    super('Remote job conflict committed without a visible authority row.');
  }
}
