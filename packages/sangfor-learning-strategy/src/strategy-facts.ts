import { randomUUID } from 'node:crypto';
import { FactService } from './fact-service.js';
import type { ResolvedStrategy, ResolverError } from './resolver.js';
import type {
  LearningFactCollection,
  LearningFactObservation,
  LearningFactQueryRequest,
} from './service-contracts.js';

/** Fact collection over a resolution that is either exact or a named refusal. */

const REFUSAL_RESOLUTION: Record<ResolverError['code'], 'canary_required' | 'research_required' | 'blocked' | 'ambiguous'> = {
  NEAR_VERSION_ONLY: 'canary_required', NO_ELIGIBLE_STRATEGY: 'research_required',
  REGISTRY_DRIFT: 'blocked', VERSION_TRUTH_MISMATCH: 'blocked', AMBIGUOUS_STRATEGY: 'ambiguous',
};

export function assertFactQueryRequest(request: LearningFactQueryRequest): void {
  if (!Array.isArray(request.factIds) || request.factIds.length === 0 || request.factIds.some((id) => typeof id !== 'string' || id.length === 0)) {
    throw new Error('INVALID_INPUT: factIds must be a non-empty string array.');
  }
}

export function collectStrategyFacts(
  request: LearningFactQueryRequest,
  resolution: ResolvedStrategy | ResolverError,
): LearningFactCollection {
  if ('code' in resolution) {
    return {
      resolution: REFUSAL_RESOLUTION[resolution.code],
      observations: request.factIds.map((factId) => ({ factId, status: 'unavailable', eligibility: 'ineligible', reason: resolution.code })),
      coverage: { requested: request.factIds.length, complete: 0, partial: 0, conflict: 0, unavailable: request.factIds.length },
      runRef: randomUUID(), evidenceFiles: [],
    };
  }
  const legacy = new FactService({ revisions: [resolution.revision], methodResults: request.methodResults }).query({
    scope: request.scope, factIds: request.factIds, context: request.context,
  });
  const observations: LearningFactObservation[] = legacy.map((item) => {
    if (item.status === 'conflict') return { factId: item.factId, status: 'conflict', eligibility: 'ineligible', conflictCandidates: item.conflictCandidates };
    if (item.status === 'complete') return { factId: item.factId, status: 'complete', eligibility: 'eligible', value: item.value, recipeRevisionId: item.revisionId, evidenceFile: item.evidenceFile, evidenceDigest: item.evidenceDigest };
    if (item.status === 'partial') return { factId: item.factId, status: 'partial', eligibility: 'ineligible', value: item.value, recipeRevisionId: item.revisionId };
    return { factId: item.factId, status: 'unavailable', eligibility: 'ineligible', reason: item.status };
  });
  const count = (status: LearningFactObservation['status']) => observations.filter((item) => item.status === status).length;
  return {
    resolution: 'exact', observations,
    coverage: { requested: observations.length, complete: count('complete'), partial: count('partial'), conflict: count('conflict'), unavailable: count('unavailable') },
    runRef: randomUUID(), evidenceFiles: [...new Set(observations.flatMap((item) => item.evidenceFile ? [item.evidenceFile] : []))],
  };
}
