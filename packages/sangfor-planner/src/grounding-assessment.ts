import type { ConfigPlan } from '@sangfor/shared';
import type { EngineerGuideStep } from '../../shared/src/engineer-case-contract.js';

/** Reference integrity is necessary, but does not prove a template's statements. */
export function assessPlanGrounding(plan: ConfigPlan) {
  const references = [...plan.manualReferences, ...plan.wikiReferences, ...plan.lessonReferences];
  const ids = new Set(references.map((reference) => reference.id));
  const steps = [...plan.precheck, ...plan.steps, ...plan.validationPlan, ...plan.rollbackPlan];
  const issues: string[] = [];
  if (ids.size !== references.length) issues.push('DUPLICATE_REFERENCE_ID');
  if (references.some((reference) => reference.product !== plan.product)) issues.push('REFERENCE_PRODUCT_MISMATCH');
  if (plan.version && references.some((reference) => reference.version !== plan.version)) issues.push('REFERENCE_VERSION_MISMATCH');
  if (references.some((reference) => !reference.text.trim())) issues.push('EMPTY_REFERENCE_TEXT');
  if (steps.some((step) => step.references.some((id) => !ids.has(id)))) issues.push('UNKNOWN_STEP_REFERENCE');
  return {
    status: issues.length ? 'INVALID_REFERENCES' as const : references.length ? 'UNVERIFIED_TEMPLATE' as const : 'INSUFFICIENT_EVIDENCE' as const,
    answerReady: false as const,
    referenceCount: references.length,
    stepCount: steps.length,
    issues,
    limitation: 'Plan steps are generated from fixed templates. Related references do not establish claim-level support or answer correctness; verify against the requested product and release before use.',
  };
}

export type EngineerGuideGroundingStatus =
  | 'GROUNDED'
  | 'UNVERIFIED_TEMPLATE'
  | 'INSUFFICIENT_EVIDENCE'
  | 'INVALID_REFERENCES';

export type EngineerGuideGrounding = {
  readonly status: EngineerGuideGroundingStatus;
  readonly answerReady: false;
  readonly referenceCount: number;
  readonly stepCount: number;
  readonly claimBoundCount: number;
  readonly issues: readonly string[];
  readonly limitation: string;
};

/**
 * Citation IDs are necessary and never sufficient. A step is claim-bound only
 * when requirement/value/evidence IDs exist and the cited evidence is bound to
 * the current or proposed value. answerReady stays false.
 */
export function assessEngineerGuideGrounding(input: {
  readonly steps: readonly EngineerGuideStep[];
  readonly evidenceIds: ReadonlySet<string>;
  readonly requirementIds: ReadonlySet<string>;
  readonly valueIds: ReadonlySet<string>;
  readonly boundEvidenceByValueId: ReadonlyMap<string, string>;
  readonly executableStepIds: ReadonlySet<string>;
  readonly citationIds?: readonly string[];
}): EngineerGuideGrounding {
  const issues: string[] = [];
  let claimBoundCount = 0;
  const citations = input.citationIds ?? input.steps.flatMap((step) => step.citations);

  for (const step of input.steps) {
    for (const ref of step.requirementRefs) {
      if (!input.requirementIds.has(ref)) issues.push(`UNKNOWN_REQUIREMENT_REF:${step.id}:${ref}`);
    }
    if (step.currentRef && !input.valueIds.has(step.currentRef)) {
      issues.push(`UNKNOWN_CURRENT_REF:${step.id}:${step.currentRef}`);
    }
    if (step.proposedRef && !input.valueIds.has(step.proposedRef)) {
      issues.push(`UNKNOWN_PROPOSED_REF:${step.id}:${step.proposedRef}`);
    }
    for (const ref of step.evidenceRefs) {
      if (!input.evidenceIds.has(ref)) issues.push(`UNKNOWN_EVIDENCE_REF:${step.id}:${ref}`);
    }
    if (!step.verify.trim() || !step.stop.trim() || !step.recovery.trim()) {
      issues.push(`MISSING_VERIFY_STOP_RECOVERY:${step.id}`);
    }

    const executable = input.executableStepIds.has(step.id);
    if (!executable) continue;
    const hasEvidence = step.evidenceRefs.length > 0 && step.evidenceRefs.every((ref) => input.evidenceIds.has(ref));
    const hasRequirement = step.requirementRefs.length > 0
      && step.requirementRefs.every((ref) => input.requirementIds.has(ref));
    const currentBound = !step.currentRef || (
      input.valueIds.has(step.currentRef)
      && (!input.boundEvidenceByValueId.has(step.currentRef)
        || step.evidenceRefs.includes(input.boundEvidenceByValueId.get(step.currentRef) ?? ''))
    );
    const proposedBound = !step.proposedRef || input.valueIds.has(step.proposedRef);
    const citationsAlone = step.citations.length > 0 && step.evidenceRefs.length === 0;
    if (citationsAlone) {
      issues.push(`CITATION_ONLY_NOT_GROUNDED:${step.id}`);
      continue;
    }
    if (hasEvidence && hasRequirement && currentBound && proposedBound) {
      claimBoundCount += 1;
    } else {
      issues.push(`CLAIM_NOT_BOUND:${step.id}`);
    }
  }

  const referenceCount = citations.length + input.steps.reduce((sum, step) => sum + step.evidenceRefs.length, 0);
  let status: EngineerGuideGroundingStatus;
  if (issues.some((issue) => issue.startsWith('UNKNOWN_'))) status = 'INVALID_REFERENCES';
  else if (input.executableStepIds.size > 0 && claimBoundCount === input.executableStepIds.size) status = 'GROUNDED';
  else if (referenceCount > 0) status = 'UNVERIFIED_TEMPLATE';
  else status = 'INSUFFICIENT_EVIDENCE';

  return {
    status,
    answerReady: false,
    referenceCount,
    stepCount: input.steps.length,
    claimBoundCount,
    issues,
    limitation: 'Reference or citation presence is not claim-level support. Executable steps need evidence bound to the cited current/proposed values. answerReady remains false.',
  };
}
