import type { ResolveIagMutationActionAuthorityInput } from '@sangfor/competency';
import {
  consumeIagMutationNonce,
  verifyIagMutationAuthorization,
} from '@sangfor/operator';
import { digestIagMutationAction } from '../apply/iag-action-authority.js';
import type { GroundedIagMutationAction } from '../apply/iag-mutation-action.js';
import type { IagPreflight } from '../apply/iag-executor.js';
import type { IagIndependentReadBack } from '../apply/iag-read-back.js';
import { persistIagTerminal, persistUncertainProgress } from './commit-resolution.js';
import { isNarrowReversibleIagAction } from './policy.js';
import { groundIagApplyResult, type IagApplyResult } from './result.js';
import type { IagOrchestratorRuntime } from './runtime.js';
import { IagOrchestratorStoreIndeterminateError } from './store.js';

export type IagOrchestratorRequest = {
  readonly actionSource: string;
  readonly authorityRequest: ResolveIagMutationActionAuthorityInput;
  readonly approval?: unknown;
  readonly ordinaryAuthorityRequired?: true;
};

type FreshRunInput = {
  readonly runtime: IagOrchestratorRuntime;
  readonly request: IagOrchestratorRequest;
  readonly action: GroundedIagMutationAction;
  readonly runId: string;
  readonly requestDigest: string;
  readonly authorizationClass: 'ordinary_active' | 'bootstrap_candidate';
};

function refusal(input: {
  readonly runId: string;
  readonly action: GroundedIagMutationAction;
  readonly reasonCode: string;
}): IagApplyResult {
  return groundIagApplyResult({
    runId: input.runId, outcome: 'REFUSED', action: input.action,
    mutationAttempted: false, reasonCode: input.reasonCode,
  });
}
function scopeFor(action: GroundedIagMutationAction) {
  return {
    actionDigest: digestIagMutationAction(action), origin: action.target.origin,
    deviceIdentityDigest: action.target.deviceIdentityDigest,
    sessionId: action.target.sessionId, windowId: action.target.windowId,
  };
}
function terminal(input: FreshRunInput, result: IagApplyResult): IagApplyResult {
  return persistIagTerminal({
    runtime: input.runtime, runId: input.runId, requestDigest: input.requestDigest,
    result, action: input.action,
  });
}
function preflightRefusal(preflight: IagPreflight): string {
  return preflight.reasonCode ?? `PREFLIGHT_${preflight.status}`;
}
function fromReadBack(input: FreshRunInput, readBack: IagIndependentReadBack, dispatchUnknown: boolean): IagApplyResult {
  if (dispatchUnknown) return groundIagApplyResult({
    runId: input.runId, outcome: 'INDETERMINATE', action: input.action,
    mutationAttempted: true, reasonCode: 'DISPATCH_OUTCOME_UNKNOWN',
  });
  switch (readBack.status) {
    case 'MATCHED': return groundIagApplyResult({
      runId: input.runId, outcome: 'SUCCEEDED', action: input.action,
      proof: readBack.proof, mutationAttempted: true,
    });
    case 'MISMATCHED': return groundIagApplyResult({
      runId: input.runId, outcome: 'FAILED_HALT', action: input.action,
      proof: readBack.proof, mutationAttempted: true, reasonCode: 'READ_BACK_MISMATCH',
    });
    case 'INDETERMINATE': return groundIagApplyResult({
      runId: input.runId, outcome: 'INDETERMINATE', action: input.action,
      proof: readBack.proof, mutationAttempted: true, reasonCode: 'READ_BACK_INDETERMINATE',
    });
    default:
      readBack.status satisfies never;
      return refusal({ runId: input.runId, action: input.action, reasonCode: 'READ_BACK_UNKNOWN' });
  }
}

export async function executeFreshIagRun(input: FreshRunInput): Promise<IagApplyResult> {
  const { runtime, action, runId, requestDigest } = input;
  runtime.store.append({ runId, requestDigest, state: 'VALIDATING', payload: { actionDigest: requestDigest } });
  if (input.request.ordinaryAuthorityRequired === true && input.authorizationClass !== 'ordinary_active') {
    return terminal(input, refusal({ runId, action, reasonCode: 'ORDINARY_AUTHORITY_REQUIRED' }));
  }
  if (!isNarrowReversibleIagAction(action)) return terminal(input, refusal({ runId, action, reasonCode: 'BROAD_OR_IRREVERSIBLE_ACTION_REFUSED' }));
  runtime.store.append({ runId, requestDigest, state: 'PREFLIGHTING' });
  const preflight = await runtime.executor.preflight(action);
  if (action.dryRun) {
    if (preflight.status !== 'READY_TO_DISPATCH' && preflight.status !== 'NO_CHANGE_CANDIDATE') {
      return terminal(input, refusal({ runId, action, reasonCode: preflightRefusal(preflight) }));
    }
    return terminal(input, groundIagApplyResult({
      runId, outcome: 'DRY_RUN_COMPLETE', action, mutationAttempted: false,
    }));
  }
  if (preflight.status === 'NO_CHANGE_CANDIDATE') {
    const proof = await runtime.executor.readBack(action);
    if (proof.status !== 'MATCHED') return terminal(input, refusal({ runId, action, reasonCode: 'NO_CHANGE_PROOF_REFUSED' }));
    return terminal(input, groundIagApplyResult({
      runId, outcome: 'NO_CHANGE_REQUIRED', action, proof: proof.proof, mutationAttempted: false,
    }));
  }
  if (preflight.status !== 'READY_TO_DISPATCH') {
    return terminal(input, refusal({ runId, action, reasonCode: preflightRefusal(preflight) }));
  }
  runtime.store.append({ runId, requestDigest, state: 'AUTHORIZING' });
  const authorization = verifyIagMutationAuthorization({
    authorizationClass: input.authorizationClass, scope: scopeFor(action),
    approval: input.request.approval, now: runtime.now(),
  });
  if (!authorization.ok) return terminal(input, refusal({ runId, action, reasonCode: authorization.code }));
  runtime.store.append({ runId, requestDigest, state: 'AUTHORIZED', payload: {
    approvedBy: authorization.approval.approvedBy,
    changeTicketId: authorization.approval.changeTicketId,
    rollbackPlanId: authorization.approval.rollbackPlanId,
    approvalToken: authorization.approval.approvalToken,
    approvalRef: authorization.nonceRef,
  } });
  runtime.store.append({ runId, requestDigest, state: 'DISPATCHING' });
  const consumed = await consumeIagMutationNonce(authorization.approval, runtime.now());
  if (!consumed.ok) return terminal(input, refusal({ runId, action, reasonCode: consumed.code }));
  const dispatch = await runtime.executor.dispatch(action);
  const possibleDispatch = dispatch.status === 'SETTLED' || dispatch.status === 'UNKNOWN';
  if (!possibleDispatch) return terminal(input, refusal({ runId, action, reasonCode: dispatch.code.toUpperCase() }));
  try {
    runtime.store.append({ runId, requestDigest, state: 'VERIFYING', payload: { dispatchStatus: dispatch.status } });
  } catch (error) {
    if (!(error instanceof IagOrchestratorStoreIndeterminateError)) throw error;
    await runtime.executor.readBack(action);
    return persistUncertainProgress({ runtime, runId, requestDigest, action });
  }
  const readBack = await runtime.executor.readBack(action);
  return terminal(input, fromReadBack(input, readBack, dispatch.status === 'UNKNOWN'));
}
