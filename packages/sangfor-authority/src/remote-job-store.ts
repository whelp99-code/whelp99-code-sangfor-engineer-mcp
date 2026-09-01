import { randomUUID } from 'node:crypto';
import {
  REMOTE_JOB_REFUSAL_REASONS,
  browserExecutionResultSchema,
  leafCertificateSchema,
  type CapabilityKey,
  type RemoteJobIndeterminateSeal,
  type RemoteJobReserveInput,
  type RemoteJobReservation,
  type RemoteJobRetainInput,
  type RemoteJobRetention,
  type RemoteJobSealInput,
  type RemoteJobStore,
} from '@sangfor/browser-contracts';
import type {
  BlroAuthorityJobInput,
  BlroDispatchAuthority,
  BlroDispatchCandidate,
  BlroTargetAuthorizationInput,
} from './blro-remote-dispatcher.js';
import { authorizeRemoteTarget } from './remote-job-authorization.js';
import { classifyRemoteJobTransaction } from './remote-job-classification.js';
import { resolvePendingRemoteJob } from './remote-job-pending.js';
import type { RemoteJobCompletionObserver } from './remote-job-completion.js';
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
import { verifyRemoteJobStoreInput } from './remote-job-store-input.js';

export type PostgresRemoteJobStoreOptions = {
  readonly database: RemoteJobDatabase;
  readonly scope: EnrollmentProjectScope;
  readonly capabilityPublicKey: CapabilityKey;
  readonly trustedIssuerBundle: string | Buffer;
  readonly clock?: EnrollmentClock;
  readonly ids?: { readonly dispatchId: () => string };
  readonly maxTransactionAttempts?: number;
  readonly completionObserver?: RemoteJobCompletionObserver;
  readonly completionTimeoutMs?: number;
  readonly reservationObserver?: {
    readonly prepared: (dispatch: RemoteJobReservation) => Promise<void>;
    readonly waiting?: (requestId: string) => Promise<void>;
  };
};

export class PostgresRemoteJobStore implements RemoteJobStore, BlroDispatchAuthority {
  private readonly database: RemoteJobDatabase;
  private readonly scope: EnrollmentProjectScope;
  private readonly capabilityPublicKey: CapabilityKey;
  private readonly trustedIssuers: readonly TrustedIssuer[];
  private readonly clock: EnrollmentClock;
  private readonly ids: { readonly dispatchId: () => string };
  private readonly maxTransactionAttempts: number;
  private readonly completionObserver: RemoteJobCompletionObserver | undefined;
  private readonly completionTimeoutMs: number;
  private readonly reservationObserver: PostgresRemoteJobStoreOptions['reservationObserver'];

  constructor(options: PostgresRemoteJobStoreOptions) {
    this.database = options.database;
    this.scope = options.scope;
    this.capabilityPublicKey = options.capabilityPublicKey;
    this.trustedIssuers = parseTrustedIssuerBundle(options.trustedIssuerBundle);
    this.clock = options.clock ?? { now: () => new Date() };
    this.ids = options.ids ?? { dispatchId: randomUUID };
    this.maxTransactionAttempts = options.maxTransactionAttempts ?? 3;
    this.completionObserver = options.completionObserver;
    this.completionTimeoutMs = options.completionTimeoutMs ?? 30_000;
    this.reservationObserver = options.reservationObserver;
  }

  async authorizeTarget(input: BlroTargetAuthorizationInput): Promise<boolean> {
    const { target } = input;
    if (target.tenantId !== this.scope.tenantId || target.projectId !== this.scope.projectId) return false;
    const certificate = leafCertificateSchema.safeParse(target.certificate);
    if (!certificate.success) return false;
    try {
      return await runRemoteJobTransaction({
        database: this.database, scope: this.scope, maxAttempts: this.maxTransactionAttempts,
        work: (transaction) => authorizeRemoteTarget({
          transaction, scope: this.scope, installationId: target.installationId,
          clientIdentityId: target.clientIdentityId, origin: target.origin,
          certificate: certificate.data, trustedIssuers: this.trustedIssuers, now: this.clock.now(),
        }),
      });
    } catch (error) {
      if (error instanceof Error) return false;
      throw error;
    }
  }

  async classify(input: BlroAuthorityJobInput): Promise<RemoteJobReservation | BlroDispatchCandidate> {
    const verified = verifyRemoteJobStoreInput({ reserve: input,
      capabilityPublicKey: this.capabilityPublicKey, scope: this.scope, now: this.clock.now() });
    if (!verified) return authorizationRefused();
    let pendingRequestId: string | undefined;
    try {
      await this.completionObserver?.ready();
      const classify = () => runRemoteJobTransaction({
        database: this.database, scope: this.scope, maxAttempts: this.maxTransactionAttempts,
        work: (transaction) => classifyRemoteJobTransaction({
          transaction, scope: this.scope, claim: verified.claim, envelope: input.envelope,
          certificate: verified.certificate, trustedIssuers: this.trustedIssuers,
          requestDigest: verified.requestDigest, now: verified.now,
        }),
      });
      const first = await classify();
      if (first.kind !== 'pending') return first;
      pendingRequestId = first.requestId;
      if (!this.completionObserver) {
        await this.reservationObserver?.waiting?.(first.requestId);
        return { kind: 'indeterminate', requestId: first.requestId };
      }
      return await resolvePendingRemoteJob({
        pending: first,
        observer: this.completionObserver,
        timeoutMs: this.completionTimeoutMs,
        classify,
        waiting: this.reservationObserver?.waiting,
      });
    } catch (error) {
      if (error instanceof Error) return pendingRequestId
        ? { kind: 'indeterminate', requestId: pendingRequestId }
        : { kind: 'unavailable' };
      throw error;
    }
  }

  reserve(input: BlroAuthorityJobInput): Promise<RemoteJobReservation> {
    return this.authorizeAndReserve(input);
  }

  async authorizeAndReserve(input: RemoteJobReserveInput): Promise<RemoteJobReservation> {
    const now = this.clock.now();
    const verified = verifyRemoteJobStoreInput({ reserve: input,
      capabilityPublicKey: this.capabilityPublicKey, scope: this.scope, now });
    if (!verified) return authorizationRefused();
    try {
      return await runRemoteJobTransaction({
        database: this.database,
        scope: this.scope,
        maxAttempts: this.maxTransactionAttempts,
        work: async (transaction) => {
          const reservation = await reserveRemoteJobTransaction({
            transaction,
            scope: this.scope,
            claim: verified.claim,
            envelope: input.envelope,
            certificate: verified.certificate,
            trustedIssuers: this.trustedIssuers,
            requestDigest: verified.requestDigest,
            dispatchId: this.ids.dispatchId(),
            now,
          });
          if (reservation.kind === 'dispatch') {
            await this.reservationObserver?.prepared(reservation);
          }
          return reservation;
        },
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
