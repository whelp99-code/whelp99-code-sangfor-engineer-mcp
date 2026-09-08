import { describe, expect, it } from 'vitest';
import {
  assertRemoteShadowQaBindings,
  RemoteShadowQaBindingError,
  type RemoteShadowQaBindingInput,
} from '../scripts/lib/remote-shadow-qa-bindings.js';

function fixture(): RemoteShadowQaBindingInput {
  const localRequiredFacts = [{ key: 'system', provenance: { collectedAt: '2026-08-27T11:59:45.000Z', latencyMs: 7 } }];
  const callbackRequiredFacts = [{ key: 'system', provenance: { collectedAt: '2026-08-27T11:59:20.000Z', latencyMs: 31 } }];
  const comparedRequiredFacts = structuredClone(callbackRequiredFacts);
  const localObservation = { path: 'local', requiredFacts: localRequiredFacts };
  const comparedRemoteObservation = { path: 'remote', requiredFacts: comparedRequiredFacts };
  return {
    localReadCount: 1,
    remoteReadCount: 1,
    executorCalls: 1,
    verificationCollectionCalls: 1,
    callbackAfterDispatchBoundary: true,
    localObservation,
    comparedRemoteObservation,
    localRequiredFacts,
    comparedRemoteRequiredFacts: comparedRequiredFacts,
    callbackRemotePayload: { requiredFacts: callbackRequiredFacts },
    comparedRemotePayload: { requiredFacts: comparedRequiredFacts },
    localTiming: { collectedAt: '2026-08-27T11:59:45.000Z', latencyMs: 7 },
    remoteTiming: { collectedAt: '2026-08-27T11:59:20.000Z', latencyMs: 31 },
  };
}

describe('remote shadow QA comparison bindings', () => {
  it('Given independently collected bound payloads, When asserted, Then structural and cryptographic evidence passes', () => {
    // Given
    const input = fixture();
    // When
    const evidence = assertRemoteShadowQaBindings(input);
    // Then
    expect(evidence).toMatchObject({ distinctCollectionObjects: true, remoteCollectionBehindMtls: true });
    expect(evidence.callbackPayloadDigest).toBe(evidence.comparedPayloadDigest);
  });

  it('Given M5 substitutes the compared remote with local, When asserted, Then it fails before PASS', () => {
    // Given
    const valid = fixture();
    const mutant = {
      ...valid,
      comparedRemoteObservation: valid.localObservation,
      comparedRemoteRequiredFacts: valid.localRequiredFacts,
      comparedRemotePayload: { requiredFacts: valid.localRequiredFacts },
    };
    // When
    const assertMutant = () => assertRemoteShadowQaBindings(mutant);
    // Then
    expect(assertMutant).toThrowError(new RemoteShadowQaBindingError('REMOTE_PAYLOAD_BINDING_FAILED'));
  });

  it('Given M6 makes remote timing equal local, When asserted, Then it fails before PASS', () => {
    // Given
    const valid = fixture();
    const mutant = { ...valid, remoteTiming: valid.localTiming };
    // When
    const assertMutant = () => assertRemoteShadowQaBindings(mutant);
    // Then
    expect(assertMutant).toThrowError(new RemoteShadowQaBindingError('ACQUISITION_METADATA_NOT_DISTINCT'));
  });
});
