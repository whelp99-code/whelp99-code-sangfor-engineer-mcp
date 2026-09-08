import {
  REMOTE_JOB_REFUSAL_REASONS,
  type JobCapabilityClaim,
  type JobEnvelope,
  type LeafCertificate,
  type RemoteJobReservation,
} from '@sangfor/browser-contracts';
import type { BlroDispatchCandidate } from './blro-remote-dispatcher.js';
import { authorizeRemoteJob } from './remote-job-authorization.js';
import type { EnrollmentProjectScope, EnrollmentSqlExecutor } from './enrollment-database.js';
import type { TrustedIssuer } from './enrollment-x509.js';
import { remoteJobCompletionKey } from './remote-job-completion.js';
import { reservationFromRemoteJobRow, type RemoteJobRow } from './remote-job-result.js';

export type ClassifyRemoteJobInput = {
  readonly transaction: EnrollmentSqlExecutor;
  readonly scope: EnrollmentProjectScope;
  readonly claim: JobCapabilityClaim;
  readonly envelope: JobEnvelope;
  readonly certificate: LeafCertificate;
  readonly trustedIssuers: readonly TrustedIssuer[];
  readonly requestDigest: string;
  readonly now: Date;
};

type JtiRow = {
  readonly tenantId: string;
  readonly projectId: string;
  readonly installationId: string;
  readonly jobId: string;
  readonly requestDigest: string;
};

export type PendingRemoteJob = {
  readonly kind: 'pending';
  readonly requestId: string;
  readonly completionKey: string;
};

export async function classifyRemoteJobTransaction(
  input: ClassifyRemoteJobInput,
): Promise<RemoteJobReservation | BlroDispatchCandidate | PendingRemoteJob> {
  const epochs = await input.transaction.$queryRawUnsafe<readonly { readonly epoch: number }[]>(
    `SELECT "epoch" FROM "BlroProjectAuthorityEpoch" WHERE "projectId"=$1 FOR SHARE`,
    input.scope.projectId,
  );
  if ((epochs[0]?.epoch ?? 0) !== input.claim.authorityEpoch) return refused();
  if (!await authorizeRemoteJob({
    transaction: input.transaction, scope: input.scope, claim: input.claim,
    request: input.envelope.request, certificate: input.certificate,
    trustedIssuers: input.trustedIssuers, now: input.now,
  })) return refused();

  const consumed = await input.transaction.$queryRawUnsafe<readonly JtiRow[]>(
    `SELECT "tenantId","projectId","installationId","jobId","requestDigest"
     FROM "BlroRemoteJobCapabilityJti" WHERE "jti"=$1`,
    input.claim.jti,
  );
  const jti = consumed[0];
  if (jti) return refused();
  const existing = await readExisting(input);
  if (existing) return decision(existing, input.requestDigest);
  return {
    kind: 'candidate',
    claim: {
      jti: input.claim.jti,
      clientIdentityId: input.claim.clientIdentityId,
      installationId: input.claim.installationId,
      authorityEpoch: input.claim.authorityEpoch,
    },
  };
}

async function readExisting(input: ClassifyRemoteJobInput): Promise<RemoteJobRow | undefined> {
  const rows = await input.transaction.$queryRawUnsafe<readonly RemoteJobRow[]>(
    `SELECT "id","tenantId","projectId","installationId","jobId","requestId",
      "requestDigest","capabilityJti","authorityEpoch","state","result","resultDigest"
     FROM "BlroRemoteJob"
     WHERE "tenantId"=$1 AND "projectId"=$2 AND "installationId"=$3
       AND "jobId"=$4 AND "authorityEpoch"=$5`,
    input.scope.tenantId, input.scope.projectId, input.claim.installationId,
    input.envelope.jobId, input.claim.authorityEpoch,
  );
  return rows[0];
}

function decision(
  row: RemoteJobRow,
  requestDigest: string,
): RemoteJobReservation | PendingRemoteJob {
  if (row.requestDigest !== requestDigest) {
    return { kind: 'refused', reason: REMOTE_JOB_REFUSAL_REASONS.REQUEST_CONFLICT };
  }
  if (row.state !== 'dispatch_committed') return reservationFromRemoteJobRow(row);
  return {
    kind: 'pending',
    requestId: row.requestId,
    completionKey: remoteJobCompletionKey({
      tenantId: row.tenantId,
      projectId: row.projectId,
      installationId: row.installationId,
      jobId: row.jobId,
      authorityEpoch: row.authorityEpoch,
    }),
  };
}

function refused(): RemoteJobReservation {
  return { kind: 'refused', reason: REMOTE_JOB_REFUSAL_REASONS.AUTHORIZATION_REFUSED };
}
