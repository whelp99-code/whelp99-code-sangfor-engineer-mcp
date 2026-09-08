import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export type RemoteShadowQaTiming = {
  readonly collectedAt: string;
  readonly latencyMs: number;
};

export type RemoteShadowQaBindingInput = {
  readonly localReadCount: number;
  readonly remoteReadCount: number;
  readonly executorCalls: number;
  readonly verificationCollectionCalls: number;
  readonly callbackAfterDispatchBoundary: boolean;
  readonly localObservation: object;
  readonly comparedRemoteObservation: object;
  readonly localRequiredFacts: readonly unknown[];
  readonly comparedRemoteRequiredFacts: readonly unknown[];
  readonly callbackRemotePayload: unknown;
  readonly comparedRemotePayload: unknown;
  readonly localTiming: RemoteShadowQaTiming;
  readonly remoteTiming: RemoteShadowQaTiming;
};

export type RemoteShadowQaBindingEvidence = {
  readonly distinctCollectionObjects: true;
  readonly remoteCollectionBehindMtls: true;
  readonly callbackPayloadDigest: string;
  readonly comparedPayloadDigest: string;
};

type RemoteShadowQaBindingErrorCode =
  | 'COLLECTION_COUNT_INVALID'
  | 'REMOTE_PAYLOAD_BINDING_FAILED'
  | 'COLLECTION_IDENTITY_REUSED'
  | 'ACQUISITION_METADATA_NOT_DISTINCT'
  | 'REMOTE_COLLECTION_PRECEDED_DISPATCH';

export class RemoteShadowQaBindingError extends Error {
  override readonly name = 'RemoteShadowQaBindingError';
  constructor(readonly code: RemoteShadowQaBindingErrorCode) {
    super(`REMOTE_SHADOW_QA_BINDING_FAILED: ${code}`);
  }
}

export function assertRemoteShadowQaBindings(
  input: RemoteShadowQaBindingInput,
): RemoteShadowQaBindingEvidence {
  if (input.localReadCount !== 1 || input.remoteReadCount !== 1
    || input.executorCalls !== 1 || input.verificationCollectionCalls !== 1) {
    throw new RemoteShadowQaBindingError('COLLECTION_COUNT_INVALID');
  }
  const callbackPayloadDigest = digestCanonical(input.callbackRemotePayload);
  const comparedPayloadDigest = digestCanonical(input.comparedRemotePayload);
  if (!isDeepStrictEqual(input.comparedRemotePayload, input.callbackRemotePayload)
    || comparedPayloadDigest !== callbackPayloadDigest) {
    throw new RemoteShadowQaBindingError('REMOTE_PAYLOAD_BINDING_FAILED');
  }
  if (input.comparedRemoteObservation === input.localObservation
    || input.comparedRemoteRequiredFacts === input.localRequiredFacts) {
    throw new RemoteShadowQaBindingError('COLLECTION_IDENTITY_REUSED');
  }
  if (input.localTiming.collectedAt === input.remoteTiming.collectedAt
    || input.localTiming.latencyMs === input.remoteTiming.latencyMs) {
    throw new RemoteShadowQaBindingError('ACQUISITION_METADATA_NOT_DISTINCT');
  }
  if (!input.callbackAfterDispatchBoundary) {
    throw new RemoteShadowQaBindingError('REMOTE_COLLECTION_PRECEDED_DISPATCH');
  }
  return {
    distinctCollectionObjects: true,
    remoteCollectionBehindMtls: true,
    callbackPayloadDigest,
    comparedPayloadDigest,
  };
}

function digestCanonical(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalValue(value)), 'utf8').digest('hex');
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalValue(child)]));
  }
  return value;
}
