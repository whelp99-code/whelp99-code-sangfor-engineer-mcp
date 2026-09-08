import type { GroundedIagMutationAction } from '../apply/iag-mutation-action.js';
import { groundIagApplyResult, type IagApplyResult } from './result.js';
import type { IagOrchestratorRuntime } from './runtime.js';
import {
  IagOrchestratorStoreIndeterminateError,
  IagOrchestratorStoreUnavailableError,
} from './store.js';

function stickyResult(input: {
  readonly runId: string;
  readonly requestDigest: string;
  readonly mutationAttempted: boolean;
  readonly action?: GroundedIagMutationAction;
  readonly reasonCode?: 'PERSISTENCE_ACK_UNCERTAIN' | 'RESTART_AFTER_INCOMPLETE_RUN';
}): IagApplyResult {
  const reasonCode = input.reasonCode ?? 'PERSISTENCE_ACK_UNCERTAIN';
  if (input.action !== undefined) {
    if (input.action.dryRun) return groundIagApplyResult({
      runId: input.runId, outcome: 'REFUSED', action: input.action,
      mutationAttempted: false, reasonCode,
    });
    return groundIagApplyResult({
      runId: input.runId, outcome: 'INDETERMINATE', action: input.action,
      mutationAttempted: input.mutationAttempted, reasonCode,
    });
  }
  return {
    runId: input.runId, outcome: 'INDETERMINATE', actionDigest: input.requestDigest,
    mutationAttempted: input.mutationAttempted, retryCount: 0, promotionEligible: false,
    verifiedSuccess: false, finalReadBack: 'UNAVAILABLE', reasonCode,
  };
}

function sealSticky(input: {
  readonly runtime: IagOrchestratorRuntime;
  readonly runId: string;
  readonly requestDigest: string;
  readonly result: IagApplyResult;
}): IagApplyResult {
  try {
    input.runtime.store.sealIndeterminate(input.runId, input.requestDigest, input.result);
  } catch (error) {
    if (!(error instanceof IagOrchestratorStoreIndeterminateError)
      && !(error instanceof IagOrchestratorStoreUnavailableError)) throw error;
  }
  return input.result;
}

export function persistIagTerminal(input: {
  readonly runtime: IagOrchestratorRuntime;
  readonly runId: string;
  readonly requestDigest: string;
  readonly result: IagApplyResult;
  readonly action?: GroundedIagMutationAction;
}): IagApplyResult {
  try {
    input.runtime.store.terminal(input.runId, input.requestDigest, input.result);
    return input.result;
  } catch (error) {
    if (!(error instanceof IagOrchestratorStoreIndeterminateError)) throw error;
    try {
      const resolution = input.runtime.store.resolveTerminal(input.runId, input.requestDigest, input.result);
      if (resolution.kind === 'COMMITTED') return resolution.result;
    } catch (resolutionError) {
      if (!(resolutionError instanceof IagOrchestratorStoreUnavailableError)) throw resolutionError;
    }
    const sticky = stickyResult({
      runId: input.runId, requestDigest: input.requestDigest,
      mutationAttempted: input.result.mutationAttempted, action: input.action,
    });
    return sealSticky({ ...input, result: sticky });
  }
}

export function persistUncertainProgress(input: {
  readonly runtime: IagOrchestratorRuntime;
  readonly runId: string;
  readonly requestDigest: string;
  readonly action: GroundedIagMutationAction;
}): IagApplyResult {
  const sticky = stickyResult({ ...input, mutationAttempted: true });
  return sealSticky({ ...input, result: sticky });
}

export function resolveUncertainReplay(input: {
  readonly runtime: IagOrchestratorRuntime;
  readonly runId: string;
  readonly requestDigest: string;
  readonly action: GroundedIagMutationAction;
  readonly mutationAttempted: boolean;
}): IagApplyResult {
  const sticky = stickyResult(input);
  return sealSticky({ ...input, result: sticky });
}

export function reconcileIagRun(runtime: IagOrchestratorRuntime, runId: string): IagApplyResult {
  const run = runtime.store.read(runId);
  if (run.terminal !== undefined) return run.terminal;
  const lastState = run.events.at(-1)?.state;
  const mutationAttempted = lastState === 'DISPATCHING' || lastState === 'VERIFYING';
  const result = stickyResult({
    runId, requestDigest: run.requestDigest, mutationAttempted,
    reasonCode: 'RESTART_AFTER_INCOMPLETE_RUN',
  });
  return sealSticky({ runtime, runId, requestDigest: run.requestDigest, result });
}
