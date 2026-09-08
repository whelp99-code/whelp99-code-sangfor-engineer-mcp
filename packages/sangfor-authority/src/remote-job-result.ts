import { createHash } from 'node:crypto';
import {
  browserExecutionResultSchema,
  type BrowserExecutionResult,
  type RemoteJobDispatch,
  type RemoteJobReservation,
} from '@sangfor/browser-contracts';
import type { EnrollmentSqlExecutor } from './enrollment-database.js';
import {
  REMOTE_JOB_COMPLETION_CHANNEL,
  remoteJobCompletionKey,
} from './remote-job-completion.js';

export type RemoteJobRow = {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly installationId: string;
  readonly jobId: string;
  readonly requestId: string;
  readonly requestDigest: string;
  readonly capabilityJti: string;
  readonly authorityEpoch: number;
  readonly state: 'dispatch_committed' | 'result_retained' | 'indeterminate';
  readonly result: unknown | null;
  readonly resultDigest: string | null;
};

type RetainResultTransactionInput = {
  readonly transaction: EnrollmentSqlExecutor;
  readonly dispatch: RemoteJobDispatch;
  readonly result: BrowserExecutionResult;
  readonly resultDigest: string;
  readonly now: Date;
};
type MarkIndeterminateTransactionInput = {
  readonly transaction: EnrollmentSqlExecutor;
  readonly dispatch: RemoteJobDispatch;
  readonly now: Date;
};

function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value !== 'object') return 'null';
  return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
}

export function remoteJobResultDigest(result: BrowserExecutionResult): string {
  return createHash('sha256').update(canonical(result)).digest('hex');
}

export function reservationFromRemoteJobRow(row: RemoteJobRow): RemoteJobReservation {
  const result = retainedRemoteJobResult(row);
  return result
    ? { kind: 'retained', result }
    : { kind: 'indeterminate', requestId: row.requestId };
}

export function retainedRemoteJobResult(
  row: RemoteJobRow,
  expectedDigest?: string,
): BrowserExecutionResult | undefined {
  switch (row.state) {
    case 'dispatch_committed':
    case 'indeterminate':
      return undefined;
    case 'result_retained': {
      if (!row.resultDigest) return undefined;
      const parsed = browserExecutionResultSchema.safeParse(row.result);
      if (!parsed.success || parsed.data.requestId !== row.requestId) return undefined;
      const digest = remoteJobResultDigest(parsed.data);
      if (digest !== row.resultDigest || (expectedDigest !== undefined && digest !== expectedDigest)) {
        return undefined;
      }
      return parsed.data;
    }
    default:
      throw new RemoteJobStateInvariantError(row.state);
  }
}

export async function readRemoteJobByDispatch(
  transaction: EnrollmentSqlExecutor,
  dispatch: RemoteJobDispatch,
): Promise<RemoteJobRow | undefined> {
  const rows = await transaction.$queryRawUnsafe<readonly RemoteJobRow[]>(
    `SELECT "id","tenantId","projectId","installationId","jobId","requestId",
      "requestDigest","capabilityJti","authorityEpoch","state","result","resultDigest"
     FROM "BlroRemoteJob"
     WHERE "id"=$1 AND "tenantId"=$2 AND "projectId"=$3 AND "installationId"=$4
       AND "jobId"=$5 AND "requestDigest"=$6 AND "capabilityJti"=$7 AND "authorityEpoch"=$8
       AND EXISTS (SELECT 1 FROM "BlroProjectAuthorityEpoch" e WHERE e."projectId"=$3 AND e."epoch"=$8)`,
    dispatch.dispatchId,
    dispatch.tenantId,
    dispatch.projectId,
    dispatch.installationId,
    dispatch.jobId,
    dispatch.requestDigest,
    dispatch.capabilityJti,
    dispatch.authorityEpoch,
  );
  return rows[0];
}

export async function retainRemoteJobResultTransaction(
  input: RetainResultTransactionInput,
): Promise<void> {
  const changed = await input.transaction.$executeRawUnsafe(
    `UPDATE "BlroRemoteJob" SET "state"='result_retained',"result"=$8::jsonb,
      "resultDigest"=$9,"resultCommittedAt"=$10,"updatedAt"=$10
     WHERE "id"=$1 AND "tenantId"=$2 AND "projectId"=$3 AND "installationId"=$4
       AND "jobId"=$5 AND "requestDigest"=$6 AND "capabilityJti"=$7
       AND "authorityEpoch"=$11 AND EXISTS (SELECT 1 FROM "BlroProjectAuthorityEpoch" e WHERE e."projectId"=$3 AND e."epoch"=$11)
       AND "state"='dispatch_committed' AND EXISTS (
         SELECT 1 FROM "BlroRemoteJobCapabilityJti" c
         WHERE c."jti"=$7 AND c."tenantId"=$2 AND c."projectId"=$3
           AND c."installationId"=$4 AND c."jobId"=$5 AND c."requestDigest"=$6
       )`,
    input.dispatch.dispatchId,
    input.dispatch.tenantId,
    input.dispatch.projectId,
    input.dispatch.installationId,
    input.dispatch.jobId,
    input.dispatch.requestDigest,
    input.dispatch.capabilityJti,
    JSON.stringify(input.result),
    input.resultDigest,
    input.now,
    input.dispatch.authorityEpoch,
  );
  if (changed > 0) await notifyCompletion(input.transaction, input.dispatch);
}

class RemoteJobStateInvariantError extends Error {
  override readonly name = 'RemoteJobStateInvariantError';
  constructor(readonly state: never) {
    super('Remote job state variant was not handled.');
  }
}

export async function markRemoteJobIndeterminateTransaction(
  input: MarkIndeterminateTransactionInput,
): Promise<void> {
  const changed = await input.transaction.$executeRawUnsafe(
    `UPDATE "BlroRemoteJob" SET "state"='indeterminate',"indeterminateAt"=$8,"updatedAt"=$8
     WHERE "id"=$1 AND "tenantId"=$2 AND "projectId"=$3 AND "installationId"=$4
       AND "jobId"=$5 AND "requestDigest"=$6 AND "capabilityJti"=$7 AND "authorityEpoch"=$9
       AND EXISTS (SELECT 1 FROM "BlroProjectAuthorityEpoch" e WHERE e."projectId"=$3 AND e."epoch"=$9)
       AND "state"='dispatch_committed'`,
    input.dispatch.dispatchId,
    input.dispatch.tenantId,
    input.dispatch.projectId,
    input.dispatch.installationId,
    input.dispatch.jobId,
    input.dispatch.requestDigest,
    input.dispatch.capabilityJti,
    input.now,
    input.dispatch.authorityEpoch,
  );
  if (changed > 0) await notifyCompletion(input.transaction, input.dispatch);
}

async function notifyCompletion(
  transaction: EnrollmentSqlExecutor,
  dispatch: RemoteJobDispatch,
): Promise<void> {
  await transaction.$executeRawUnsafe(
    `SELECT pg_notify('${REMOTE_JOB_COMPLETION_CHANNEL}',$1)`,
    remoteJobCompletionKey(dispatch),
  );
}
