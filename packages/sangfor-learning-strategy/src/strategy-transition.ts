import { promoteLearningApproval, type LearningApprovalEvent } from './approval.js';
import { getTransitionRequirements, isValidTransition } from './lifecycle.js';
import type {
  PromoteStrategyRequest,
  StrategyPromotion,
  StrategyValidation,
  ValidateStrategyRequest,
} from './service-contracts.js';
import { openStrategyStore, type StrategyStoreAccess, uniqueRevisions } from './strategy-store-access.js';
import type { StrategyRevision, StrategyState } from './store.js';

/** State transitions of a strategy revision: eligibility, then the approval-gated commit. */

const LOWERCASE_SHA256 = /^[a-f0-9]{64}$/u;
const CANDIDATE_STATES: StrategyState[] = ['researched', 'lab_verified', 'device_verified', 'strategy_field_verified', 'stale', 'deprecated'];

export function toValidationRequest(request: PromoteStrategyRequest): ValidateStrategyRequest {
  return {
    strategyId: request.strategyId,
    revisionId: request.revisionId,
    ...(request.evidenceFile === undefined ? {} : { evidenceFile: request.evidenceFile }),
    ...(request.evidenceDigest === undefined ? {} : { evidenceDigest: request.evidenceDigest }),
  };
}

export function validateStrategyRevision(access: StrategyStoreAccess, request: ValidateStrategyRequest): StrategyValidation {
  const { store } = openStrategyStore(access, request.strategyId);
  const revision = uniqueRevisions(store).find((candidate) => candidate.revisionId === request.revisionId);
  if (!revision) throw new Error('REVISION_NOT_FOUND: exact revision is required.');
  const errors: string[] = [];
  if (!request.evidenceFile && !revision.evidenceFile) errors.push('EVIDENCE_REQUIRED');
  if (request.evidenceDigest !== undefined && !LOWERCASE_SHA256.test(request.evidenceDigest)) errors.push('EVIDENCE_DIGEST_INVALID');
  const eligibleNextStates = errors.length === 0 ? CANDIDATE_STATES.filter((state) => isValidTransition(revision.state, state)) : [];
  return { valid: errors.length === 0, revision, eligibleNextStates, errors };
}

export async function promoteStrategyRevision(
  access: StrategyStoreAccess,
  request: PromoteStrategyRequest,
  validation: StrategyValidation,
): Promise<StrategyPromotion> {
  if (!validation.valid) throw new Error(`VALIDATION_FAILED: ${validation.errors.join(',')}`);
  if (!isValidTransition(validation.revision.state, request.toState)) throw new Error(`INVALID_TRANSITION: ${validation.revision.state} -> ${request.toState}`);
  if (request.approvalPayload.entityType !== 'strategy'
    || request.approvalPayload.entityId !== request.strategyId
    || request.approvalPayload.revisionId !== request.revisionId
    || request.approvalPayload.toState !== request.toState
    || request.approvalPayload.fromState !== validation.revision.state) {
    throw new Error('APPROVAL_BINDING_MISMATCH: approval must bind the exact strategy, revision, source state, and target state.');
  }
  const requirements = getTransitionRequirements(validation.revision.state, request.toState);
  if (!requirements?.requiresHumanHmac) throw new Error('APPROVAL_REQUIRED: transition is not configured for signed approval.');
  const { manager, store } = openStrategyStore(access, request.strategyId);
  let event: LearningApprovalEvent | undefined;
  let promotedRevision: StrategyRevision | undefined;
  await promoteLearningApproval({
    payload: request.approvalPayload,
    approvalToken: request.approvalToken,
    currentState: validation.revision.state,
    currentContentHash: validation.revision.contentHash,
    evidenceRoot: request.evidenceRoot,
    appendEvent: async (value) => {
      const next = manager.addRevision(store, {
        ...validation.revision,
        state: request.toState,
        derivedFromRevisionId: validation.revision.revisionId,
        evidenceFile: request.approvalPayload.evidenceFile,
        evidenceDigest: request.approvalPayload.evidenceDigest,
        strategyId: request.strategyId,
        contentHash: validation.revision.contentHash,
      });
      next.lifecycleEvents = [...store.lifecycleEvents, value];
      const committed = await manager.commit(next, store.currentGeneration);
      if (!committed.ok) throw new Error(`STORE_COMMIT_FAILED: ${committed.error ?? 'unknown'}`);
      const committedStore = manager.load();
      if (!committedStore) throw new Error('STORE_UNAVAILABLE: promoted strategy could not be reloaded.');
      const revision = uniqueRevisions(committedStore).at(-1);
      if (!revision) throw new Error('REVISION_NOT_FOUND: promoted strategy has no revision.');
      event = value;
      promotedRevision = revision;
    },
  });
  if (!promotedRevision || !event) throw new Error('PROMOTION_RESULT_UNAVAILABLE: approval did not append a promotion result.');
  return { revision: promotedRevision, event };
}
