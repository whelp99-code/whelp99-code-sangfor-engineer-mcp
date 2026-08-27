import { createHash, randomUUID } from 'node:crypto';
import {
  JobCapabilityError,
  REMOTE_JOB_REFUSAL_REASONS,
  browserExecutionRequestDigest,
  verifyJobCapability,
  type JobCapabilityClaim,
  type RemoteJobIndeterminateSeal,
  type RemoteJobReservation,
  type RemoteJobReserveInput,
  type RemoteJobRetainInput,
  type RemoteJobRetention,
  type RemoteJobSealInput,
  type RemoteJobStore,
} from '@sangfor/browser-contracts';
import { verifyAuthorityReceipt, type AuthorityReceipt } from './authority-receipt.js';
import type { GrantSnapshot } from './grant-snapshot.js';
import { KeyRing } from './key-ring.js';
import {
  RefusalJournalError,
  type JournalReservationInput,
  type RefusalJournal,
} from './refusal-journal.js';

export const REMOTE_BROWSER_EXECUTION_SCOPE = 'browser:execute' as const;
export const RECEIPT_HEADER = 'x-sangfor-authority-receipt' as const;
export const RECEIPT_ID_HEADER = 'x-sangfor-authority-receipt-id' as const;

export type ReceiptRemoteJobStoreOptions = {
  /** The per-request signed receipt, supplied by the transport for this call. */
  readonly receiptFor: (input: RemoteJobReserveInput) => string | undefined;
  /** The peer fingerprint the receipt must name, from the live mTLS socket. */
  readonly clientFingerprintFor: (input: RemoteJobReserveInput) => string | undefined;
  /** The receiptId BLRO announces out of band; never read from the receipt. */
  readonly receiptIdFor: (input: RemoteJobReserveInput) => string | undefined;
  readonly snapshot: () => GrantSnapshot;
  readonly keyRing: KeyRing;
  readonly journal: RefusalJournal;
  readonly allowedOrigin: string;
  readonly now: () => Date;
  readonly onDecision?: (reason: string) => void;
};

/**
 * The JM-side dispatch gate.
 *
 * It verifies a per-dispatch BLRO receipt whose every binding must match the
 * actual request, reserves that receipt in a durable hash-chained journal
 * BEFORE the executor runs, and records the post-dispatch observation. It can
 * only refuse: it never mints authority and never returns a PASS.
 */
export function createReceiptRemoteJobStore(
  options: ReceiptRemoteJobStoreOptions,
): RemoteJobStore {
  const reserved = new Map<string, JournalReservationInput>();
  return {
    async authorizeAndReserve(input: RemoteJobReserveInput): Promise<RemoteJobReservation> {
      const authorized = authorize(input, options);
      if ('reason' in authorized) {
        options.onDecision?.(authorized.reason);
        return refusal(authorized.reason);
      }
      const { receipt, claim } = authorized;
      const key = {
        jobId: receipt.jobId,
        receiptId: receipt.receiptId,
        requestId: receipt.requestId,
        capabilityJti: claim.jti,
        requestDigest: receipt.requestDigest,
        capabilityDigest: receipt.capabilityDigest,
        reservationDigest: receipt.reservationDigest,
      };
      let reservation;
      try {
        reservation = options.journal.reserve(key, options.now());
      } catch (error) {
        // A journal that cannot be read or written is a closed door, not an
        // open one: without it JM cannot promise at-most-once dispatch.
        options.onDecision?.(error instanceof RefusalJournalError ? error.reason : 'JOURNAL_FAILED');
        return { kind: 'unavailable' };
      }
      switch (reservation.kind) {
        case 'duplicate':
          options.onDecision?.('JOURNAL_DUPLICATE_REFUSED');
          return { kind: 'indeterminate', requestId: receipt.requestId };
        case 'conflict':
          options.onDecision?.('JOURNAL_CONFLICT_REFUSED');
          return refusal(REMOTE_JOB_REFUSAL_REASONS.REQUEST_CONFLICT);
        case 'reserved':
          break;
        default:
          throw new JmDispatchInvariantError(reservation);
      }
      options.onDecision?.('DISPATCH_AUTHORIZED');
      // Remember the exact reserved row so the post-dispatch observation records
      // the same digests rather than approximating them.
      reserved.set(receipt.jobId, key);
      return {
        kind: 'dispatch',
        dispatch: {
          dispatchId: randomUUID(),
          tenantId: receipt.tenantId,
          projectId: receipt.projectId,
          authorityEpoch: receipt.authorityEpoch,
          installationId: receipt.installationId,
          jobId: receipt.jobId,
          requestId: receipt.requestId,
          requestDigest: receipt.requestDigest,
          capabilityJti: claim.jti,
        },
      };
    },

    /**
     * JM observes; BLRO decides. The observation is journalled so a restart
     * knows a dispatch already happened, and the caller always receives
     * indeterminate so no JM-local state can be mistaken for a verdict.
     */
    async retainResult(input: RemoteJobRetainInput): Promise<RemoteJobRetention> {
      recordObservation(options, reserved.get(input.dispatch.jobId));
      return { kind: 'indeterminate' };
    },

    async markIndeterminate(input: RemoteJobSealInput): Promise<RemoteJobIndeterminateSeal> {
      recordObservation(options, reserved.get(input.dispatch.jobId));
      return { kind: 'sealed' };
    },
  };
}

function recordObservation(
  options: ReceiptRemoteJobStoreOptions,
  row: JournalReservationInput | undefined,
): void {
  if (!row) return;
  try {
    options.journal.recordIndeterminate(row, options.now());
    options.onDecision?.('OBSERVATION_RECORDED');
  } catch (error) {
    options.onDecision?.(error instanceof RefusalJournalError ? error.reason : 'JOURNAL_FAILED');
  }
}

export const DISPATCH_REFUSALS = {
  RECEIPT_MISSING: 'RECEIPT_MISSING',
  CLIENT_FINGERPRINT_MISSING: 'CLIENT_FINGERPRINT_MISSING',
  ORIGIN_NOT_ALLOWED: 'ORIGIN_NOT_ALLOWED',
  SNAPSHOT_ENROLLMENT_REVOKED: 'SNAPSHOT_ENROLLMENT_REVOKED',
  GRANT_SCOPE_REFUSED: 'GRANT_SCOPE_REFUSED',
} as const;

type Authorized = { readonly receipt: AuthorityReceipt; readonly claim: JobCapabilityClaim };

function authorize(
  input: RemoteJobReserveInput,
  options: ReceiptRemoteJobStoreOptions,
): Authorized | { readonly reason: string } {
  const encoded = options.receiptFor(input);
  if (!encoded) return { reason: 'RECEIPT_MISSING' };
  const fingerprint = options.clientFingerprintFor(input);
  if (!fingerprint) return { reason: 'CLIENT_FINGERPRINT_MISSING' };
  const snapshot = options.snapshot();
  if (snapshot.state === 'revoked') return { reason: 'SNAPSHOT_ENROLLMENT_REVOKED' };
  const now = options.now();
  const origin = input.envelope.request.origin;
  if (origin !== options.allowedOrigin) return { reason: 'ORIGIN_NOT_ALLOWED' };

  const keyId = receiptKeyIdUnverified(encoded);
  if (!keyId) return { reason: 'RECEIPT_FORMAT_INVALID' };
  const resolved = options.keyRing.resolve(keyId, now);
  if (!resolved.ok) return { reason: resolved.reason };

  const claim = parseCapability(input, resolved.entry.publicKeyPem, now);
  if ('reason' in claim) return claim;

  const announced = options.receiptIdFor(input);
  if (!announced) return { reason: 'RECEIPT_ID_UNANNOUNCED' };
  const decision = verifyAuthorityReceipt({
    receipt: encoded,
    publicKeyPem: resolved.entry.publicKeyPem,
    expected: {
      receiptId: announced,
      tenantId: snapshot.tenantId,
      projectId: snapshot.projectId,
      installationId: snapshot.installationId,
      deviceBindingDigest: snapshot.deviceBindingDigest,
      authorityEpoch: snapshot.authorityEpoch,
      origin,
      jobId: input.envelope.jobId,
      requestId: input.envelope.request.requestId,
      capabilityJti: claim.claim.jti,
      requestDigest: browserExecutionRequestDigest(input.envelope.request),
      capabilityDigest: digestOf(input.envelope.capability),
      capabilityVerifyKeyId: resolved.entry.keyId,
      capabilityVerifyKeyDigest: resolved.digest,
      clientCertificateFingerprintSha256: fingerprint,
    },
    now,
  });
  if (!decision.ok) return { reason: decision.reason };
  if (!grantsAllow(snapshot, decision.receipt.origin)) return { reason: 'GRANT_SCOPE_REFUSED' };
  return { receipt: decision.receipt, claim: claim.claim };
}

function receiptKeyIdUnverified(encoded: string): string | undefined {
  try {
    const payload = encoded.trim().split('.')[0];
    if (!payload) return undefined;
    const decoded: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof decoded !== 'object' || decoded === null) return undefined;
    const keyId = (decoded as { readonly capabilityVerifyKeyId?: unknown }).capabilityVerifyKeyId;
    return typeof keyId === 'string' ? keyId : undefined;
  } catch {
    return undefined;
  }
}

export function digestOf(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function parseCapability(
  input: RemoteJobReserveInput,
  publicKey: string,
  now: Date,
): { readonly claim: JobCapabilityClaim } | { readonly reason: string } {
  try {
    return { claim: verifyJobCapability({ envelope: input.envelope, publicKey, now }) };
  } catch (error) {
    return { reason: error instanceof JobCapabilityError ? error.code : 'CAPABILITY_INVALID' };
  }
}

function grantsAllow(snapshot: GrantSnapshot, origin: string): boolean {
  const originDigest = createHash('sha256')
    .update(`sangfor.origin.v1\u0000${origin}`, 'utf8').digest('hex');
  return snapshot.grants.some((grant) => (
    grant.originDigest === originDigest && grant.scope === REMOTE_BROWSER_EXECUTION_SCOPE
  ));
}

function refusal(reason: string): RemoteJobReservation {
  return reason === REMOTE_JOB_REFUSAL_REASONS.REQUEST_CONFLICT
    ? { kind: 'refused', reason: REMOTE_JOB_REFUSAL_REASONS.REQUEST_CONFLICT }
    : { kind: 'refused', reason: REMOTE_JOB_REFUSAL_REASONS.AUTHORIZATION_REFUSED };
}

class JmDispatchInvariantError extends Error {
  override readonly name = 'JmDispatchInvariantError';
  constructor(readonly value: never) {
    super('Journal reservation variant was not handled.');
  }
}
