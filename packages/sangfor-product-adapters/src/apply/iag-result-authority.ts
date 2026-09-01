import { isGroundedIagMutationAction, digestIagMutationAction } from './iag-action-authority.js';
import {
  canonicalIagValuesEqual,
} from './iag-mutation-canonical.js';
import {
  registerGroundedResult,
  resultMatchesAuthority,
} from './iag-mutation-authority.js';
import {
  structuralIagMutationResultSchema,
  type GroundedIagMutationResult,
} from './iag-mutation-result.js';
import {
  digestIagReadBackProof,
  observedPreStateIsAbsent,
  observedPreStateIsExact,
  readBackProofMatchesAction,
  type GroundedIagReadBackProof,
} from './iag-readback-authority.js';
import { parseStructuralJson, refused, type IagMutationParseResult } from './iag-mutation-parser.js';

export function parseIagMutationResult(input: {
  readonly source: string;
  readonly action: unknown;
  readonly readBackProof?: unknown;
}): IagMutationParseResult<GroundedIagMutationResult> {
  if (!isGroundedIagMutationAction(input.action)) return refused('result_authority_refused');
  const action = input.action;
  const parsed = parseStructuralJson({
    source: input.source,
    schema: structuralIagMutationResultSchema,
    schemaName: 'iag-internet-policy-result.v1',
  });
  if (!parsed.ok) return parsed;
  const result = parsed.value;
  let valid = canonicalIagValuesEqual(result.action, action);
  if (result.actionDigest !== digestIagMutationAction(action)) valid = false;
  let proofAuthority: GroundedIagReadBackProof | undefined;

  switch (result.outcome) {
    case 'DRY_RUN_COMPLETE':
      if (!action.dryRun || input.readBackProof !== undefined) valid = false;
      break;
    case 'REFUSED':
      if (input.readBackProof !== undefined) valid = false;
      break;
    case 'SUCCEEDED':
      if (action.dryRun || !observedPreStateIsAbsent(action)
        || !readBackProofMatchesAction(input.readBackProof, action)) {
        valid = false;
      } else {
        proofAuthority = input.readBackProof;
        if (proofAuthority.result !== 'MATCHED'
          || result.readBackProofDigest !== digestIagReadBackProof(proofAuthority)) valid = false;
      }
      break;
    case 'NO_CHANGE_REQUIRED':
      if (action.dryRun || !observedPreStateIsExact(action)
        || !readBackProofMatchesAction(input.readBackProof, action)) {
        valid = false;
      } else {
        proofAuthority = input.readBackProof;
        if (proofAuthority.result !== 'MATCHED'
          || result.readBackProofDigest !== digestIagReadBackProof(proofAuthority)) valid = false;
      }
      break;
    case 'FAILED_HALT':
      if (action.dryRun || !readBackProofMatchesAction(input.readBackProof, action)) {
        valid = false;
      } else {
        proofAuthority = input.readBackProof;
        if (proofAuthority.result !== 'MISMATCHED'
          || result.readBackProofDigest !== digestIagReadBackProof(proofAuthority)) valid = false;
      }
      break;
    case 'INDETERMINATE':
      if (action.dryRun) valid = false;
      const finalReadBack = result.finalReadBack;
      switch (finalReadBack) {
        case 'INDETERMINATE':
          if (!readBackProofMatchesAction(input.readBackProof, action)) {
            valid = false;
          } else {
            proofAuthority = input.readBackProof;
            if (proofAuthority.result !== 'INDETERMINATE'
              || result.readBackProofDigest !== digestIagReadBackProof(proofAuthority)) valid = false;
          }
          break;
        case 'UNAVAILABLE':
          if (input.readBackProof !== undefined || result.readBackProofDigest !== null) valid = false;
          break;
        default:
          finalReadBack satisfies never;
      }
      break;
    default:
      result satisfies never;
  }

  if (!valid) return refused('result_authority_refused');
  return {
    ok: true,
    value: registerGroundedResult(result, action, proofAuthority),
  };
}

function resultHasExactAuthority(
  result: unknown,
  action: object,
  proof: object | undefined,
): result is GroundedIagMutationResult {
  return resultMatchesAuthority(result, action, proof);
}

export function verifyIagMutationResult(input: {
  readonly result: unknown;
  readonly action: unknown;
  readonly readBackProof?: unknown;
}): IagMutationParseResult<GroundedIagMutationResult> {
  if (!isGroundedIagMutationAction(input.action)) return refused('result_authority_refused');
  const proof = input.readBackProof;
  if (proof !== undefined && !readBackProofMatchesAction(proof, input.action)) {
    return refused('result_authority_refused');
  }
  if (!resultHasExactAuthority(input.result, input.action, proof)) return refused('result_authority_refused');
  return { ok: true, value: input.result };
}
