import { z } from 'zod';
import {
  structuralIagExpectedStateSchema,
  structuralIagMutationActionSchema,
  structuralIagObservedStateSchema,
  structuralIagUnavailableStateSchema,
  type GroundedIagMutationAction,
  type IagMutationObservedState,
} from './iag-mutation-action.js';
import {
  isGroundedProof,
  proofMatchesAction,
  registerGroundedProof,
} from './iag-mutation-authority.js';
import { canonicalIagValuesEqual, digestCanonicalIagValue } from './iag-mutation-canonical.js';
import { structuralSha256Schema, structuralVerifierSessionIdSchema } from './iag-mutation-primitives.js';
import { digestIagMutationAction, isGroundedIagMutationAction } from './iag-action-authority.js';
import { parseStructuralJson, refused, type IagMutationParseResult } from './iag-mutation-parser.js';

export const IAG_READBACK_SCHEMA_VERSION = 'iag-independent-readback.v1' as const;
const STATE_DIGEST_DOMAIN = 'sangfor.iag.observed-state.v1';
const PROOF_DIGEST_DOMAIN = 'sangfor.iag.readback-proof.v1';

const structuralProofSchema = z.object({
  schemaVersion: z.literal(IAG_READBACK_SCHEMA_VERSION),
  action: structuralIagMutationActionSchema,
  actionDigest: structuralSha256Schema,
  verifierSessionId: structuralVerifierSessionIdSchema,
  result: z.enum(['MATCHED', 'MISMATCHED', 'INDETERMINATE']),
  expected: structuralIagExpectedStateSchema,
  observed: z.union([structuralIagObservedStateSchema, structuralIagUnavailableStateSchema]),
  observedStateDigest: structuralSha256Schema.nullable(),
  observedAt: z.string().datetime({ offset: true }),
}).strict().readonly();

export type GroundedIagReadBackProof = z.infer<typeof structuralProofSchema>;

export function digestIagObservedState(state: unknown): string {
  const parsed = structuralIagObservedStateSchema.parse(state);
  return digestCanonicalIagValue(STATE_DIGEST_DOMAIN, parsed);
}

export function parseIagReadBackProof(input: {
  readonly source: string;
  readonly action: unknown;
}): IagMutationParseResult<GroundedIagReadBackProof> {
  if (!isGroundedIagMutationAction(input.action)) return refused('readback_authority_refused');
  const action = input.action;
  const parsed = parseStructuralJson({
    source: input.source,
    schema: structuralProofSchema,
    schemaName: IAG_READBACK_SCHEMA_VERSION,
  });
  if (!parsed.ok) return parsed;
  const proof = parsed.value;

  let valid = canonicalIagValuesEqual(proof.action, action);
  if (proof.actionDigest !== digestIagMutationAction(action)) valid = false;
  if (proof.verifierSessionId !== action.readBackExpectation.verifierSessionId) valid = false;
  if (!canonicalIagValuesEqual(proof.expected, action.readBackExpectation.expected)) valid = false;

  switch (proof.result) {
    case 'MATCHED':
      if (proof.observed.kind === 'UNAVAILABLE'
        || !canonicalIagValuesEqual(proof.observed, proof.expected)
        || proof.observedStateDigest !== digestIagObservedState(proof.observed)) valid = false;
      break;
    case 'MISMATCHED':
      if (proof.observed.kind === 'UNAVAILABLE'
        || canonicalIagValuesEqual(proof.observed, proof.expected)
        || proof.observedStateDigest !== digestIagObservedState(proof.observed)) valid = false;
      break;
    case 'INDETERMINATE':
      if (proof.observed.kind !== 'UNAVAILABLE' || proof.observedStateDigest !== null) valid = false;
      break;
    default:
      proof.result satisfies never;
  }
  if (!valid) return refused('readback_authority_refused');
  return { ok: true, value: registerGroundedProof(proof, action) };
}

export function digestIagReadBackProof(proof: unknown): string {
  if (!isGroundedProof(proof)) throw new TypeError('IAG_READBACK_AUTHORITY_REQUIRED');
  return digestCanonicalIagValue(PROOF_DIGEST_DOMAIN, proof);
}

export function readBackProofMatchesAction(proof: unknown, action: object): proof is GroundedIagReadBackProof {
  return proofMatchesAction(proof, action);
}

export function observedPreStateIsExact(action: GroundedIagMutationAction): boolean {
  return canonicalIagValuesEqual(action.preState.observed, action.readBackExpectation.expected);
}

export function observedPreStateIsAbsent(action: GroundedIagMutationAction): boolean {
  const observed: IagMutationObservedState = action.preState.observed;
  return observed.kind === 'URL_DOMAIN_EXCEPTION_ABSENT' || observed.kind === 'APPLICATION_EXCEPTION_ABSENT';
}
