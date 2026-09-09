import type { ConfigPlan } from '@sangfor/shared';

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
