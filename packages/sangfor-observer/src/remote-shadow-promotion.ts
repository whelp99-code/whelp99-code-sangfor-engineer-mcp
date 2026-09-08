import { verify, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import type { RemoteShadowObservation } from './remote-shadow-types.js';

const nonEmpty = z.string().min(1);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const signature = z.string().min(1).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u);
const signedIdentitySchema = z.object({
  keyId: nonEmpty,
  observationDigest: sha256,
  signature,
}).strict();

export const remoteShadowPromotionProofSchema = z.object({
  schemaVersion: z.literal('remote-shadow-promotion-proof.v1'),
  evidenceClass: z.literal('real'),
  sourceIdentity: nonEmpty,
  sourceScope: nonEmpty,
  local: signedIdentitySchema,
  remote: signedIdentitySchema,
}).strict();

export type RemoteShadowPromotionProof = z.infer<typeof remoteShadowPromotionProofSchema>;
export type RemoteShadowTrustedIdentity = {
  readonly keyId: string;
  readonly publicKey: KeyObject;
};
export type RemoteShadowPromotionTrust = {
  readonly local: RemoteShadowTrustedIdentity;
  readonly remote: RemoteShadowTrustedIdentity;
};

type PromotionInput = {
  readonly local: RemoteShadowObservation;
  readonly remote: RemoteShadowObservation;
  readonly localObservationDigest: string;
  readonly remoteObservationDigest: string;
  readonly proof: unknown;
  readonly trust: RemoteShadowPromotionTrust | undefined;
};

export function remoteShadowPromotionPayload(input: {
  readonly side: 'local' | 'remote';
  readonly observationDigest: string;
  readonly sourceIdentity: string;
  readonly sourceScope: string;
}): string {
  return [
    'remote-shadow-promotion-proof.v1', 'real', input.side, input.observationDigest,
    input.sourceIdentity, input.sourceScope,
  ].join('\n');
}

export function hasAuthenticatedRemoteShadowPromotionEvidence(input: PromotionInput): boolean {
  const parsed = remoteShadowPromotionProofSchema.safeParse(input.proof);
  if (!parsed.success || input.trust === undefined) return false;
  const proof = parsed.data;
  if (input.local.target.sourceVersion === 'mock-v1' || input.remote.target.sourceVersion === 'mock-v1') return false;
  if (proof.sourceScope !== input.local.target.sourceScope
    || proof.sourceScope !== input.remote.target.sourceScope
    || proof.local.observationDigest !== input.localObservationDigest
    || proof.remote.observationDigest !== input.remoteObservationDigest
    || proof.local.keyId !== input.trust.local.keyId
    || proof.remote.keyId !== input.trust.remote.keyId
    || proof.local.keyId === proof.remote.keyId
    || input.trust.local.publicKey.equals(input.trust.remote.publicKey)
    || !factsMatchIdentity(input.local, proof.sourceIdentity, proof.sourceScope)
    || !factsMatchIdentity(input.remote, proof.sourceIdentity, proof.sourceScope)) return false;
  return verifyIdentity('local', proof, input.trust.local.publicKey)
    && verifyIdentity('remote', proof, input.trust.remote.publicKey);
}

function factsMatchIdentity(
  observation: RemoteShadowObservation,
  sourceIdentity: string,
  sourceScope: string,
): boolean {
  return observation.requiredFacts.every((fact) => fact.provenance.sourceIdentity === sourceIdentity
    && fact.provenance.sourceScope === sourceScope);
}

function verifyIdentity(
  side: 'local' | 'remote',
  proof: RemoteShadowPromotionProof,
  publicKey: KeyObject,
): boolean {
  const signed = proof[side];
  const payload = remoteShadowPromotionPayload({
    side,
    observationDigest: signed.observationDigest,
    sourceIdentity: proof.sourceIdentity,
    sourceScope: proof.sourceScope,
  });
  try {
    return verify(null, Buffer.from(payload, 'utf8'), publicKey, Buffer.from(signed.signature, 'base64'));
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) return false;
    throw error;
  }
}
