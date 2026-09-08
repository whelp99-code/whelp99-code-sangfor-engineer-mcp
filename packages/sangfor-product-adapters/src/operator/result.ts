import type {
  GroundedIagMutationAction,
} from '../apply/iag-mutation-action.js';
import { digestIagMutationAction } from '../apply/iag-action-authority.js';
import {
  structuralIagMutationResultSchema,
  type GroundedIagMutationResult,
} from '../apply/iag-mutation-result.js';
import type { GroundedIagReadBackProof } from '../apply/iag-readback-authority.js';
import { digestIagReadBackProof } from '../apply/iag-readback-authority.js';
import { parseIagMutationResult } from '../apply/iag-result-authority.js';
import type { IagTerminalState } from './state.js';
import { z } from 'zod';

export type IagApplyResult = {
  readonly runId: string;
  readonly outcome: IagTerminalState;
  readonly actionDigest: string | null;
  readonly mutationAttempted: boolean;
  readonly retryCount: 0;
  readonly promotionEligible: false;
  readonly verifiedSuccess: boolean;
  readonly finalReadBack: 'NONE' | 'MATCHED' | 'MISMATCHED' | 'INDETERMINATE' | 'UNAVAILABLE';
  readonly reasonCode?: string;
  readonly groundedResult?: GroundedIagMutationResult;
};

const storedResultSchema = z.object({
  runId: z.string().regex(/^[a-f0-9]{64}$/u),
  outcome: z.enum(['DRY_RUN_COMPLETE', 'NO_CHANGE_REQUIRED', 'REFUSED', 'SUCCEEDED', 'FAILED_HALT', 'INDETERMINATE']),
  actionDigest: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  mutationAttempted: z.boolean(), retryCount: z.literal(0), promotionEligible: z.literal(false),
  verifiedSuccess: z.boolean(),
  finalReadBack: z.enum(['NONE', 'MATCHED', 'MISMATCHED', 'INDETERMINATE', 'UNAVAILABLE']),
  reasonCode: z.string().min(1).optional(), groundedResult: structuralIagMutationResultSchema.optional(),
}).strict().readonly();

export function parseStoredIagApplyResult(value: unknown): IagApplyResult {
  return storedResultSchema.parse(value);
}

type GroundResultInput = {
  readonly runId: string;
  readonly outcome: Exclude<IagTerminalState, 'REFUSED'> | 'REFUSED';
  readonly action: GroundedIagMutationAction;
  readonly proof?: GroundedIagReadBackProof;
  readonly mutationAttempted: boolean;
  readonly reasonCode?: string;
};

function structuralResult(input: GroundResultInput): object {
  const common = {
    schemaVersion: 'iag-internet-policy-result.v1', action: input.action,
    actionDigest: digestIagMutationAction(input.action), promotionEligible: false,
  } as const;
  switch (input.outcome) {
    case 'DRY_RUN_COMPLETE':
      return { ...common, outcome: input.outcome, mutation: { attempted: false, count: 0 }, verifiedSuccess: false, finalReadBack: 'NONE' };
    case 'NO_CHANGE_REQUIRED':
    case 'SUCCEEDED':
      return {
        ...common, outcome: input.outcome,
        mutation: input.outcome === 'SUCCEEDED' ? { attempted: true, count: 1 } : { attempted: false, count: 0 },
        verifiedSuccess: true, finalReadBack: 'MATCHED',
        readBackProofDigest: input.proof === undefined ? '' : digestIagReadBackProof(input.proof),
      };
    case 'FAILED_HALT':
      return {
        ...common, outcome: input.outcome,
        mutation: { attempted: input.mutationAttempted, count: input.mutationAttempted ? 1 : 0 },
        verifiedSuccess: false, finalReadBack: 'MISMATCHED',
        readBackProofDigest: input.proof === undefined ? '' : digestIagReadBackProof(input.proof),
        reasonCode: input.reasonCode ?? 'READ_BACK_MISMATCH',
      };
    case 'INDETERMINATE':
      return {
        ...common, outcome: input.outcome,
        mutation: { attempted: input.mutationAttempted, count: input.mutationAttempted ? 1 : 0 },
        verifiedSuccess: false,
        finalReadBack: input.proof === undefined ? 'UNAVAILABLE' : 'INDETERMINATE',
        readBackProofDigest: input.proof === undefined ? null : digestIagReadBackProof(input.proof),
        reasonCode: input.reasonCode ?? 'READ_BACK_INDETERMINATE',
      };
    case 'REFUSED':
      return {
        ...common, outcome: input.outcome, mutation: { attempted: false, count: 0 },
        verifiedSuccess: false, finalReadBack: 'NONE', reasonCode: input.reasonCode ?? 'REFUSED',
      };
    default:
      input.outcome satisfies never;
      return common;
  }
}

export function groundIagApplyResult(input: GroundResultInput): IagApplyResult {
  const parsed = parseIagMutationResult({
    source: JSON.stringify(structuralResult(input)), action: input.action, readBackProof: input.proof,
  });
  if (!parsed.ok) throw new TypeError(`IAG_ORCHESTRATOR_RESULT_REFUSED:${parsed.refusal.code}`);
  return {
    runId: input.runId, outcome: input.outcome,
    actionDigest: digestIagMutationAction(input.action),
    mutationAttempted: parsed.value.mutation.attempted, retryCount: 0,
    promotionEligible: false, verifiedSuccess: parsed.value.verifiedSuccess,
    finalReadBack: parsed.value.finalReadBack,
    ...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }),
    groundedResult: parsed.value,
  };
}

export function ungroundedRefusal(runId: string, reasonCode: string): IagApplyResult {
  return {
    runId, outcome: 'REFUSED', actionDigest: null, mutationAttempted: false,
    retryCount: 0, promotionEligible: false, verifiedSuccess: false,
    finalReadBack: 'NONE', reasonCode,
  };
}
