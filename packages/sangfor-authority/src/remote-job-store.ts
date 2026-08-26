import { randomUUID } from 'node:crypto';
import {
  JobCapabilityError,
  REMOTE_JOB_REFUSAL_REASONS,
  browserExecutionRequestDigest,
  browserExecutionResultSchema,
  leafCertificateSchema,
  verifyJobCapability,
  type CapabilityKey,
  type JobCapabilityClaim,
  type RemoteJobIndeterminateSeal,
  type RemoteJobReserveInput,
  type RemoteJobReservation,
  type RemoteJobRetainInput,
  type RemoteJobRetention,
  type RemoteJobSealInput,
  type RemoteJobStore,
} from '@sangfor/browser-contracts';
import {
  parseTrustedIssuerBundle,
  type TrustedIssuer,
} from './enrollment-x509.js';
import type {
  EnrollmentClock,
  EnrollmentProjectScope,
} from './enrollment-database.js';
import {
  runRemoteJobTransaction,
  type RemoteJobDatabase,
} from './remote-job-database.js';
import {
  RemoteJobReservationRollback,
  reserveRemoteJobTransaction,
} from './remote-job-reservation.js';
import {
  markRemoteJobIndeterminateTransaction,
  readRemoteJobByDispatch,
  remoteJobResultDigest,
  retainedRemoteJobResult,
  retainRemoteJobResultTransaction,
} from './remote-job-result.js';

export type PostgresRemoteJobStoreOptions = {
  readonly database: RemoteJobDatabase;
  readonly scope: EnrollmentProjectScope;
  readonly capabilityPublicKey: CapabilityKey;
  readonly trustedIssuerBundle: string | Buffer;
  readonly clock?: EnrollmentClock;
  readonly ids?: { readonly dispatchId: () => string };
  readonly maxTransactionAttempts?: number;
};

export class PostgresRemoteJobStore implements RemoteJobStore {
  private readonly database: RemoteJobDatabase;
  private readonly scope: EnrollmentProjectScope;
  private readonly capabilityPublicKey: CapabilityKey;
  private readonly trustedIssuers: readonly TrustedIssuer[];
  private readonly clock: EnrollmentClock;
  private readonly ids: { readonly dispatchId: () => string };
  private readonly maxTransactionAttempts: number;

  constructor(options: PostgresRemoteJobStoreOptions) {
    this.database = options.database;
    this.scope = options.scope;
    this.capabilityPublicKey = options.capabilityPublicKey;
    this.trustedIssuers = parseTrustedIssuerBundle(options.trustedIssuerBundle);
    this.clock = options.clock ?? { now: () => new Date() };
    this.ids = options.ids ?? { dispatchId: randomUUID };
    this.maxTransactionAttempts = options.maxTransactionAttempts ?? 3;
  }

  async authorizeAndReserve(input: RemoteJobReserveInput): Promise<RemoteJobReservation> {
    const now = this.clock.now();
    let claim: JobCapabilityClaim;
    try {
      claim = verifyJobCapability({
        envelope: input.envelope,
        publicKey: this.capabilityPublicKey,
        now,
      });
    } catch (error) {
      if (error instanceof JobCapabilityError) return authorizationRefused();
      throw error;
    }
    if (claim.tenantId !== this.scope.tenantId || claim.projectId !== this.scope.projectId) {
      return authorizationRefused();
    }
    const certificate = leafCertificateSchema.safeParse(input.certificate);
    if (!certificate.success) return authorizationRefused();
    try {
      return await runRemoteJobTransaction({
        database: this.database,
        scope: this.scope,
        maxAttempts: this.maxTransactionAttempts,
        work: (transaction) => reserveRemoteJobTransaction({
          transaction,
          scope: this.scope,
          claim,
          envelope: input.envelope,
          certificate: certificate.data,
          trustedIssuers: this.trustedIssuers,
          requestDigest: browserExecutionRequestDigest(input.envelope.request),
          dispatchId: this.ids.dispatchId(),
          now,
        }),
      });
    } catch (error) {
      if (error instanceof RemoteJobReservationRollback) return error.reservation;
      if (error instanceof Error) return { kind: 'unavailable' };
      throw error;
    }
  }

  async retainResult(input: RemoteJobRetainInput): Promise<RemoteJobRetention> {
    if (!this.dispatchMatchesScope(input.dispatch)) return { kind: 'indeterminate' };
    const parsed = browserExecutionResultSchema.safeParse(input.result);
    if (!parsed.success || parsed.data.requestId !== input.dispatch.requestId) {
      return { kind: 'indeterminate' };
    }
    const digest = remoteJobResultDigest(parsed.data);
    const now = this.clock.now();
    try {
      await runRemoteJobTransaction({
        database: this.database,
        scope: this.scope,
        maxAttempts: this.maxTransactionAttempts,
        work: (transaction) => retainRemoteJobResultTransaction({
          transaction,
          dispatch: input.dispatch,
          result: parsed.data,
          resultDigest: digest,
          now,
        }),
      });
      const row = await runRemoteJobTransaction({
        database: this.database,
        scope: this.scope,
        maxAttempts: this.maxTransactionAttempts,
        work: (transaction) => readRemoteJobByDispatch(transaction, input.dispatch),
      });
      const retained = row ? retainedRemoteJobResult(row, digest) : undefined;
      return retained ? { kind: 'retained', result: retained } : { kind: 'indeterminate' };
    } catch (error) {
      if (error instanceof Error) return { kind: 'indeterminate' };
      throw error;
    }
  }

  async markIndeterminate(input: RemoteJobSealInput): Promise<RemoteJobIndeterminateSeal> {
    if (!this.dispatchMatchesScope(input.dispatch)) return { kind: 'unknown' };
    try {
      await runRemoteJobTransaction({
        database: this.database,
        scope: this.scope,
        maxAttempts: this.maxTransactionAttempts,
        work: (transaction) => markRemoteJobIndeterminateTransaction({
          transaction,
          dispatch: input.dispatch,
          now: this.clock.now(),
        }),
      });
      return { kind: 'sealed' };
    } catch (error) {
      if (error instanceof Error) return { kind: 'unknown' };
      throw error;
    }
  }

  private dispatchMatchesScope(dispatch: RemoteJobRetainInput['dispatch']): boolean {
    return dispatch.tenantId === this.scope.tenantId && dispatch.projectId === this.scope.projectId;
  }
}

function authorizationRefused(): RemoteJobReservation {
  return { kind: 'refused', reason: REMOTE_JOB_REFUSAL_REASONS.AUTHORIZATION_REFUSED };
}
