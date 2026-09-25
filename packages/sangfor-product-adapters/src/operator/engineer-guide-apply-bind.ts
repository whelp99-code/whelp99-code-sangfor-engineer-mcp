/**
 * E13: bind one engineer-guide step to an existing IAG dry-run apply path.
 *
 * Real-device mutation stays closed. A 2xx is never success. INDETERMINATE
 * never retries. HCI guide apply is unsupported until a reversible HCI action
 * is selected from E00/field evidence.
 */
import { createHash } from 'node:crypto';
import type { EngineerGuide } from '@sangfor/shared';
import { digestIagMutationAction } from '../apply/iag-action-authority.js';
import type { IagExecutor } from '../apply/iag-executor.js';
import type {
  GroundedIagMutationAction,
  IagMutationObservedState,
} from '../apply/iag-mutation-action.js';
import { dryRunIagMutation } from './dry-run.js';
import type { IagOrchestratorRequest } from './run-machine.js';
import { isNarrowReversibleIagAction } from './policy.js';
import type { IagApplyResult } from './result.js';

export type EngineerGuideApplyObserved =
  | IagMutationObservedState
  | { readonly kind: 'UNAVAILABLE'; readonly reasonCode: string };

export type EngineerGuideApplyStepView = {
  readonly stepId: string;
  readonly executable: boolean;
  readonly support: 'executable' | 'blocked' | 'unsupported';
};

export type EngineerGuideApplyProposal = {
  readonly digest: string;
  readonly guideRevision: string;
  readonly guideDigest: string;
  readonly stepId: string;
  readonly product: 'IAG';
  readonly actionDigest: string;
  readonly before: IagMutationObservedState;
  readonly after: GroundedIagMutationAction['readBackExpectation']['expected'];
  readonly action: GroundedIagMutationAction;
};

export type EngineerGuideApplyProposeFailure = {
  readonly ok: false;
  readonly code: string;
  readonly mutationAttempted: false;
  readonly retry: false;
};

export type EngineerGuideApplyProposeSuccess = {
  readonly ok: true;
  readonly proposal: EngineerGuideApplyProposal;
};

export type EngineerGuideApplyProposeResult =
  | EngineerGuideApplyProposeSuccess
  | EngineerGuideApplyProposeFailure;

export type EngineerGuideApplyDryRunSuccess = {
  readonly ok: true;
  readonly mutationAttempted: false;
  readonly verifiedSuccess: false;
  readonly httpSuccessIgnored: true;
  readonly retry: false;
  readonly proposalDigest: string;
  readonly dryRun: IagApplyResult;
};

export type EngineerGuideApplyDryRunFailure = EngineerGuideApplyProposeFailure & {
  readonly verifiedSuccess: false;
  readonly httpSuccessIgnored: true;
};

export type EngineerGuideApplyDryRunResult =
  | EngineerGuideApplyDryRunSuccess
  | EngineerGuideApplyDryRunFailure;

function fail(code: string): EngineerGuideApplyProposeFailure {
  return { ok: false, code, mutationAttempted: false, retry: false };
}

function isExecutableStepView(view: EngineerGuideApplyStepView | undefined): boolean {
  return view !== undefined && view.support === 'executable' && view.executable === true;
}

function refuseUnlessStoredExecutable(input: {
  readonly storedStepViews?: readonly EngineerGuideApplyStepView[];
  readonly stepViews: readonly EngineerGuideApplyStepView[];
  readonly stepId: string;
}): EngineerGuideApplyProposeFailure | undefined {
  // Caller stepViews cannot grant executable. Only stored E07 step views can.
  const storedView = (input.storedStepViews ?? []).find((candidate) => candidate.stepId === input.stepId);
  if (!isExecutableStepView(storedView)) return fail('STEP_NOT_EXECUTABLE');
  const callerView = input.stepViews.find((candidate) => candidate.stepId === input.stepId);
  if (callerView !== undefined && !isExecutableStepView(callerView)) return fail('STEP_NOT_EXECUTABLE');
  return undefined;
}

function dryFail(code: string): EngineerGuideApplyDryRunFailure {
  return { ...fail(code), verifiedSuccess: false, httpSuccessIgnored: true };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
  }
  throw new Error('E13_PROPOSAL_CANONICAL_NON_JSON');
}

export function digestEngineerGuideApplyProposal(
  input: Omit<EngineerGuideApplyProposal, 'digest' | 'action'>,
): string {
  return createHash('sha256').update(canonicalJson(input), 'utf8').digest('hex');
}

function observedEqual(left: IagMutationObservedState, right: IagMutationObservedState): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function proposeEngineerGuideApply(input: {
  readonly guide: EngineerGuide;
  readonly storedStepViews?: readonly EngineerGuideApplyStepView[];
  readonly stepViews: readonly EngineerGuideApplyStepView[];
  readonly stepId: string;
  readonly product: 'IAG' | 'HCI';
  readonly action: GroundedIagMutationAction;
  readonly currentObserved?: EngineerGuideApplyObserved;
}): EngineerGuideApplyProposeResult {
  if (input.product === 'HCI') return fail('HCI_GUIDE_APPLY_UNSUPPORTED');
  if (input.guide.readiness !== 'review_ready') return fail('GUIDE_NOT_REVIEW_READY');
  if (input.guide.steps.length !== 1) return fail('SINGLE_GUIDE_STEP_REQUIRED');
  const step = input.guide.steps[0];
  if (step === undefined || step.id !== input.stepId) return fail('STEP_NOT_IN_GUIDE');
  const executable = refuseUnlessStoredExecutable(input);
  if (executable !== undefined) return executable;
  if (input.action.target.product !== 'IAG') return fail('ACTION_PRODUCT_MISMATCH');
  if (input.action.dryRun !== true) return fail('IAG_DRY_RUN_ACTION_REQUIRED');
  if (!isNarrowReversibleIagAction(input.action)) return fail('BROAD_OR_IRREVERSIBLE_ACTION_REFUSED');
  if (input.currentObserved === undefined || input.currentObserved.kind === 'UNAVAILABLE') {
    return fail('PRESTATE_INDETERMINATE');
  }
  if (!observedEqual(input.currentObserved, input.action.preState.observed)) {
    return fail('DRIFT_REQUIRES_REPLAN');
  }

  const actionDigest = digestIagMutationAction(input.action);
  const unsigned = {
    guideRevision: input.guide.revision,
    guideDigest: input.guide.digest,
    stepId: input.stepId,
    product: 'IAG' as const,
    actionDigest,
    before: input.action.preState.observed,
    after: input.action.readBackExpectation.expected,
  };
  return {
    ok: true,
    proposal: {
      ...unsigned,
      digest: digestEngineerGuideApplyProposal(unsigned),
      action: input.action,
    },
  };
}

export function assertEngineerGuideApplyBinding(input: {
  readonly proposal: EngineerGuideApplyProposal;
  readonly currentGuide: EngineerGuide;
  readonly currentObserved?: EngineerGuideApplyObserved;
}): EngineerGuideApplyProposeResult {
  if (input.currentGuide.digest !== input.proposal.guideDigest
    || input.currentGuide.revision !== input.proposal.guideRevision) {
    return fail('STALE_GUIDE');
  }
  if (input.currentObserved === undefined || input.currentObserved.kind === 'UNAVAILABLE') {
    return fail('PRESTATE_INDETERMINATE');
  }
  if (!observedEqual(input.currentObserved, input.proposal.before)) {
    return fail('DRIFT_REQUIRES_REPLAN');
  }
  const unsigned = {
    guideRevision: input.proposal.guideRevision,
    guideDigest: input.proposal.guideDigest,
    stepId: input.proposal.stepId,
    product: input.proposal.product,
    actionDigest: input.proposal.actionDigest,
    before: input.proposal.before,
    after: input.proposal.after,
  };
  if (digestEngineerGuideApplyProposal(unsigned) !== input.proposal.digest) {
    return fail('PROPOSAL_TAMPERED');
  }
  return { ok: true, proposal: input.proposal };
}

export async function dryRunEngineerGuideApply(input: {
  readonly proposal: EngineerGuideApplyProposal;
  readonly currentGuide: EngineerGuide;
  readonly currentObserved?: EngineerGuideApplyObserved;
  readonly storedStepViews?: readonly EngineerGuideApplyStepView[];
  readonly stepViews: readonly EngineerGuideApplyStepView[];
  readonly executor: IagExecutor;
  readonly authorityRequest: IagOrchestratorRequest['authorityRequest'];
}): Promise<EngineerGuideApplyDryRunResult> {
  const rebound = proposeEngineerGuideApply({
    guide: input.currentGuide,
    storedStepViews: input.storedStepViews,
    stepViews: input.stepViews,
    stepId: input.proposal.stepId,
    product: input.proposal.product,
    action: input.proposal.action,
    currentObserved: input.currentObserved,
  });
  if (!rebound.ok) return dryFail(rebound.code);
  const binding = assertEngineerGuideApplyBinding({
    proposal: input.proposal,
    currentGuide: input.currentGuide,
    currentObserved: input.currentObserved,
  });
  if (!binding.ok) return dryFail(binding.code);
  if (rebound.proposal.digest !== input.proposal.digest) return dryFail('STALE_GUIDE');
  if (input.proposal.action.dryRun !== true) return dryFail('IAG_DRY_RUN_ACTION_REQUIRED');

  const dryRun = await dryRunIagMutation({
    request: {
      actionSource: JSON.stringify(input.proposal.action),
      authorityRequest: input.authorityRequest,
    },
    executor: input.executor,
  });
  if (dryRun.mutationAttempted) {
    return dryFail('DRY_RUN_MUTATION_ATTEMPTED');
  }
  if (dryRun.outcome !== 'DRY_RUN_COMPLETE' && dryRun.outcome !== 'NO_CHANGE_REQUIRED') {
    return dryFail(dryRun.reasonCode ?? dryRun.outcome);
  }
  return {
    ok: true,
    mutationAttempted: false,
    verifiedSuccess: false,
    httpSuccessIgnored: true,
    retry: false,
    proposalDigest: input.proposal.digest,
    dryRun,
  };
}
