import type {
  EngineerAssessment,
  EngineerCalculation,
  EngineerCaseDocument,
  EngineerGuide,
  EngineerRequirement,
} from '../../shared/src/engineer-case-contract.js';

export type RequirementRevisionStale = {
  readonly staleCalculationIds: readonly string[];
  readonly staleAssessmentIds: readonly string[];
  readonly deletedRequirementIds: readonly string[];
  readonly addedRequirementIds: readonly string[];
  readonly guideStale: boolean;
  readonly reasons: readonly string[];
};

function signature(requirement: EngineerRequirement): string {
  return [
    requirement.revision,
    requirement.sourceKind,
    requirement.target ?? '',
    requirement.constraint ?? '',
    requirement.priority,
    requirement.confirmationState,
    requirement.acceptanceCriterion,
  ].join('\u001f');
}

function staleCalculation(calculation: EngineerCalculation, reason: string): EngineerCalculation {
  return {
    ...calculation,
    result: { presence: 'unknown', reason },
  };
}

function staleAssessment(assessment: EngineerAssessment, reason: string): EngineerAssessment {
  return {
    ...assessment,
    status: 'unresolved',
    reasons: [reason],
    nextAction: 'add_information',
  };
}

function staleGuide(
  guide: EngineerGuide,
  reasons: readonly string[],
  deletedRequirementIds: readonly string[],
): EngineerGuide {
  const deleted = new Set(deletedRequirementIds);
  const unresolved = [...new Set([...guide.unresolved, ...reasons])];
  return {
    ...guide,
    requirementRefs: guide.requirementRefs.filter((id) => !deleted.has(id)),
    steps: guide.steps.map((step) => ({
      ...step,
      requirementRefs: step.requirementRefs.filter((id) => !deleted.has(id)),
    })),
    unresolved,
    readiness: unresolved.length > 0 ? 'blocked' : 'draft',
  };
}

/**
 * Requirement edits never overwrite observations. Dependent calculations and
 * the current guide become stale; they are not auto-recomputed or marked PASS.
 */
export function applyRequirementRevision(
  document: EngineerCaseDocument,
  nextRequirements: readonly EngineerRequirement[],
): { readonly document: EngineerCaseDocument; readonly stale: RequirementRevisionStale } {
  const previousById = new Map(document.requirements.map((item) => [item.id, item]));
  const nextIds = new Set(nextRequirements.map((item) => item.id));
  const deletedRequirementIds = document.requirements
    .filter((item) => !nextIds.has(item.id))
    .map((item) => item.id);
  const addedRequirementIds = nextRequirements
    .filter((item) => !previousById.has(item.id))
    .map((item) => item.id);
  const changedIds = nextRequirements
    .filter((item) => {
      const previous = previousById.get(item.id);
      return previous !== undefined && signature(previous) !== signature(item);
    })
    .map((item) => item.id);
  const dirtyIds = new Set([...deletedRequirementIds, ...changedIds]);

  const staleAssessmentIds = document.assessments
    .filter((item) => dirtyIds.has(item.requirementRef))
    .map((item) => item.id);
  const staleCalculationIds = [...new Set(
    document.assessments
      .filter((item) => dirtyIds.has(item.requirementRef))
      .flatMap((item) => item.calculationRefs),
  )];
  const guideTouchesDirty = document.guide.requirementRefs.some((id) => dirtyIds.has(id))
    || document.guide.steps.some((step) => step.requirementRefs.some((id) => dirtyIds.has(id)));
  const reasons = [
    ...changedIds.map((id) => `STALE_REQUIREMENT_REVISION:${id}`),
    ...deletedRequirementIds.map((id) => `STALE_REQUIREMENT_DELETED:${id}`),
    ...addedRequirementIds.map((id) => `REQUIREMENT_ADDED_UNASSESSED:${id}`),
  ];
  const guideStale = guideTouchesDirty || deletedRequirementIds.length > 0 || addedRequirementIds.length > 0;

  const calculations = document.calculations.map((item) => (
    staleCalculationIds.includes(item.id)
      ? staleCalculation(item, reasons[0] ?? 'STALE_REQUIREMENT_REVISION')
      : item
  ));
  const assessments = document.assessments
    .filter((item) => !deletedRequirementIds.includes(item.requirementRef))
    .map((item) => (
      staleAssessmentIds.includes(item.id)
        ? staleAssessment(item, `STALE_REQUIREMENT_REVISION:${item.requirementRef}`)
        : item
    ));
  const guide = guideStale ? staleGuide(document.guide, reasons, deletedRequirementIds) : document.guide;

  return {
    document: {
      ...document,
      requirements: nextRequirements,
      observations: document.observations,
      calculations,
      assessments,
      guide,
    },
    stale: {
      staleCalculationIds,
      staleAssessmentIds: staleAssessmentIds.filter((id) => assessments.some((item) => item.id === id)),
      deletedRequirementIds,
      addedRequirementIds,
      guideStale,
      reasons,
    },
  };
}

export function attachRequirementsToCase(
  document: EngineerCaseDocument,
  requirements: readonly EngineerRequirement[],
): EngineerCaseDocument {
  return {
    ...document,
    requirements,
    observations: document.observations,
  };
}
