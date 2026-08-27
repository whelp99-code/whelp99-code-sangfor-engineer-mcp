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
import type {
  BlroAuthorityJobInput,
  BlroDispatchAuthority,
  BlroDispatchCandidate,
  BlroTargetAuthorizationInput,
} from './blro-remote-dispatcher.js';
import { authorizeRemoteTarget } from './remote-job-authorization.js';
import { classifyRemoteJobTransaction } from './remote-job-classification.js';
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

export class PostgresRemoteJobStore implements RemoteJobStore, BlroDispatchAuthority {
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
    const verified = this.verifiedInput(input);
    if (!verified) return authorizationRefused();
    try {
      return await runRemoteJobTransaction({
        database: this.database, scope: this.scope, maxAttempts: this.maxTransactionAttempts,
        work: (transaction) => classifyRemoteJobTransaction({
          transaction, scope: this.scope, claim: verified.claim, envelope: input.envelope,
          certificate: verified.certificate, trustedIssuers: this.trustedIssuers,
          requestDigest: verified.requestDigest, now: verified.now,
        }),
      });
    } catch (error) {
      if (error instanceof Error) return { kind: 'unavailable' };
      throw error;
    }
  }

  reserve(input: BlroAuthorityJobInput): Promise<RemoteJobReservation> {
    return this.authorizeAndReserve(input);
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

  private verifiedInput(input: BlroAuthorityJobInput): {
    readonly claim: JobCapabilityClaim;
    readonly certificate: ReturnType<typeof leafCertificateSchema.parse>;
    readonly requestDigest: string;
    readonly now: Date;
  } | undefined {
    const now = this.clock.now();
    let claim: JobCapabilityClaim;
    try {
      claim = verifyJobCapability({ envelope: input.envelope, publicKey: this.capabilityPublicKey, now });
    } catch (error) {
      if (error instanceof JobCapabilityError) return undefined;
      throw error;
    }
    if (claim.tenantId !== this.scope.tenantId || claim.projectId !== this.scope.projectId) return undefined;
    const certificate = leafCertificateSchema.safeParse(input.certificate);
    if (!certificate.success) return undefined;
    return { claim, certificate: certificate.data,
      requestDigest: browserExecutionRequestDigest(input.envelope.request), now };
  }

  private dispatchMatchesScope(dispatch: RemoteJobRetainInput['dispatch']): boolean {
    return dispatch.tenantId === this.scope.tenantId && dispatch.projectId === this.scope.projectId;
  }
}

function authorizationRefused(): RemoteJobReservation {
  return { kind: 'refused', reason: REMOTE_JOB_REFUSAL_REASONS.AUTHORIZATION_REFUSED };
}
