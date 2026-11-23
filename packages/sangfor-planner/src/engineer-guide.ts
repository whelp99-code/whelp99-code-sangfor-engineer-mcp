/**
 * Evidence-based engineer guide assembly and readiness (E07).
 *
 * Revision/digest are an in-memory contract. Durable save is E09A/E09B.
 * Catalog menu claims are not verified firmware paths. This module never
 * mutates a device and never emits approved_for_window or field_accepted.
 */
import {
  assertEngineerAssessmentScope,
  isHciSnapshotSurfaceObservation,
} from '../../sangfor-config-state/src/engineer-assessment-scope.js';
import {
  computeEngineerGuideDigest,
  type EngineerAssessment,
  type EngineerCalculation,
  type EngineerCase,
  type EngineerCaseDocument,
  type EngineerGuide,
  type EngineerGuideReadiness,
  type EngineerGuideStep,
  type EngineerObservation,
  type EngineerRequirement,
  type EngineerSourceKind,
} from '../../shared/src/engineer-case-contract.js';
import { assembleEngineerCase, type EngineerCaseAssembly } from './engineer-case.js';
import { assessEngineerGuideGrounding, type EngineerGuideGrounding } from './grounding-assessment.js';

export { computeEngineerGuideDigest };

export type EngineerGuideStepSupport = 'executable' | 'blocked' | 'unsupported';

export type EngineerGuideTemplateStep = {
  readonly title: string;
  readonly description: string;
  readonly firmware?: string;
};

export type EngineerGuideSearchDocument = {
  readonly source: string;
  readonly text: string;
};

export type EngineerGuideChangeRecord = {
  readonly fromRevision?: string;
  readonly fromDigest?: string;
  readonly toRevision: string;
  readonly toDigest: string;
  readonly reasons: readonly string[];
};

export type EngineerGuideStepView = {
  readonly step: EngineerGuideStep;
  readonly support: EngineerGuideStepSupport;
  readonly executable: boolean;
  readonly reasons: readonly string[];
  readonly target?: string;
  readonly prerequisites: readonly string[];
  readonly currentSourceKind?: EngineerSourceKind;
  readonly proposedSourceKind?: EngineerSourceKind;
  readonly settingPath: {
    readonly kind: 'verified_verify' | 'catalog_claim' | 'none';
    readonly evidence: string;
  };
};

export type EngineerGuideBuildRequest = {
  readonly document: EngineerCaseDocument;
  readonly auth: { readonly tenantId: string; readonly projectId: string; readonly actorId: string };
  readonly caseRevision: string;
  readonly expectedProduct?: EngineerCaseDocument['product'];
  readonly expectedFirmware?: string;
  readonly companionRevisions?: readonly string[];
  readonly assessments?: readonly EngineerAssessment[];
  readonly calculations?: readonly EngineerCalculation[];
  readonly template?: {
    readonly product?: string;
    readonly firmware?: string;
    readonly steps?: readonly EngineerGuideTemplateStep[];
  };
  readonly searchDocuments?: readonly EngineerGuideSearchDocument[];
  readonly searchCitations?: readonly { readonly requirementId: string; readonly source: string }[];
  readonly priorGuide?: EngineerGuide;
  readonly llmExplanation?: string;
  readonly hciHealthVerdict?: 'PASS' | 'FAIL' | 'INDETERMINATE';
};

export type EngineerGuideBuildSuccess = {
  readonly ok: true;
  readonly guide: EngineerGuide;
  readonly document: EngineerCase;
  readonly assembled: EngineerCaseAssembly;
  readonly stepViews: readonly EngineerGuideStepView[];
  readonly grounding: EngineerGuideGrounding;
  readonly blockers: readonly string[];
  readonly risks: readonly string[];
  readonly pmDecisions: readonly string[];
  readonly changeHistory: readonly EngineerGuideChangeRecord[];
  readonly ignoredSearchDirectives: readonly string[];
  readonly guideReadyGranted: boolean;
  readonly persisted: false;
};

export type EngineerGuideBuildFailure = {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly guideReadyGranted: false;
};

export type EngineerGuideBuildResult = EngineerGuideBuildSuccess | EngineerGuideBuildFailure;

const SEARCH_DIRECTIVE_RE =
  /(?:\b(?:curl|wget|ssh|chmod|sudo|pnpm|npm|bash|sh)\b|\bsangfor_[a-z0-9_]+\b|run (?:the )?(?:tool|command)|execute (?:tool|command)|extract (?:the )?(?:password|secret|token)|도구를 실행|비밀번호를 추출)/iu;
const SECRET_TEXT_RE = /(?:password|secret|token|authorization|cookie|비밀번호|패스워드|토큰)\s*[:=]\s*\S+/giu;
const CAPACITY_HA_RE = /ha|capacity|headroom|잔여|용량|host_cpu|host_ram|storage|network|usable/i;
const PROXY_PASS_RE = /DOCUMENT_SEARCH|문서 검색|SNAPSHOT_NOT_CAPABILITY_ROW|VM_COUNT_NOT_CAPACITY|volume-status|capacity-or-ha:INDETERMINATE/;
const INDETERMINATE_RE = /INDETERMINATE|BASELINE_SOURCE_MISSING|fitness:[A-Z0-9_]*INDETERMINATE/;

function clip(text: string, max: number): string {
  const masked = text.replace(SECRET_TEXT_RE, (match) => `${match.split(/[:=]/u)[0]}=***`);
  return masked.length <= max ? masked : `${masked.slice(0, max - 3)}...`;
}

function clipList(items: readonly string[], maxItems: number, maxLen: number): string[] {
  return [...new Set(items.map((item) => clip(item, maxLen)).filter((item) => item.length > 0))].slice(0, maxItems);
}

function guideRevision(document: EngineerCaseDocument): string {
  const id = `g-${document.revision}`.slice(0, 64);
  return id.length > 0 ? id : 'g-rev';
}

function valueRecord(
  document: EngineerCaseDocument,
  calculations: readonly EngineerCalculation[],
  id: string | undefined,
): EngineerObservation | EngineerCalculation | undefined {
  if (!id) return undefined;
  return document.observations.find((item) => item.id === id)
    ?? calculations.find((item) => item.id === id);
}

function sourceKindOf(
  record: EngineerObservation | EngineerCalculation | undefined,
): EngineerSourceKind | undefined {
  return record?.sourceKind;
}

function evidenceForValue(
  document: EngineerCaseDocument,
  calculations: readonly EngineerCalculation[],
  id: string | undefined,
): string | undefined {
  if (!id) return undefined;
  const observation = document.observations.find((item) => item.id === id);
  if (observation?.evidenceRef) return observation.evidenceRef;
  const calculation = calculations.find((item) => item.id === id);
  if (!calculation) return undefined;
  for (const inputId of calculation.inputRefs) {
    const input = document.observations.find((item) => item.id === inputId);
    if (input?.evidenceRef) return input.evidenceRef;
  }
  return undefined;
}

function isCapacityOrHaRequirement(
  requirement: EngineerRequirement | undefined,
  assessment: EngineerAssessment,
): boolean {
  return CAPACITY_HA_RE.test([
    assessment.requirementRef,
    requirement?.id,
    requirement?.target,
    requirement?.constraint,
    requirement?.acceptanceCriterion,
  ].filter((item): item is string => Boolean(item)).join(' '));
}

function isSnapshotCurrentRefForCapacityOrHa(
  assessment: EngineerAssessment,
  requirement: EngineerRequirement | undefined,
): boolean {
  return Boolean(
    assessment.currentRef
    && isHciSnapshotSurfaceObservation(assessment.currentRef)
    && isCapacityOrHaRequirement(requirement, assessment),
  );
}

function isProxyCapacityHaPass(assessment: EngineerAssessment): boolean {
  if (assessment.status !== 'satisfied') return false;
  const blob = `${assessment.requirementRef} ${assessment.reasons.join(' ')}`;
  return CAPACITY_HA_RE.test(blob) && PROXY_PASS_RE.test(assessment.reasons.join(' '));
}

function isIndeterminateMarkedSatisfied(assessment: EngineerAssessment): boolean {
  return assessment.status === 'satisfied' && INDETERMINATE_RE.test(assessment.reasons.join(' '));
}

function templateIssues(
  document: EngineerCaseDocument,
  template: EngineerGuideBuildRequest['template'],
): string[] {
  if (!template) return [];
  const issues: string[] = [];
  if (template.product && template.product !== document.product) {
    issues.push(`TEMPLATE_PRODUCT_CONFLICT:${template.product}!=${document.product}`);
  }
  if (template.firmware && document.firmware && template.firmware !== document.firmware) {
    issues.push(`TEMPLATE_FIRMWARE_CONFLICT:${template.firmware}!=${document.firmware}`);
  }
  const text = (template.steps ?? []).map((step) => `${step.title} ${step.description}`).join('\n');
  for (const step of template.steps ?? []) {
    if (step.firmware && document.firmware && step.firmware !== document.firmware) {
      issues.push(`TEMPLATE_FIRMWARE_CONFLICT:${step.firmware}!=${document.firmware}`);
    }
  }
  const ha = document.observations.find((item) => item.id === 'obs-ha_status' || item.id.includes('ha_status'));
  if (ha?.value.presence === 'known' && ha.value.data.kind === 'boolean') {
    if (/\bHA enabled\b/iu.test(text) && ha.value.data.boolean === false) {
      issues.push('TEMPLATE_VALUE_CONFLICT:ha_status');
    }
    if (/\bHA disabled\b/iu.test(text) && ha.value.data.boolean === true) {
      issues.push('TEMPLATE_VALUE_CONFLICT:ha_status');
    }
  }
  if (/\b(host cpu|host ram|network topology|N\+1)\b/iu.test(text)) {
    const provided = document.observations.some((item) => (
      /host_cpu|host_ram|network_topology/.test(item.id)
      && item.value.presence === 'known'
      && (item.sourceKind === 'provided' || item.sourceKind === 'observed')
    ));
    if (!provided) issues.push('TEMPLATE_UNKNOWN_FABRICATED:host-or-network');
  }
  return [...new Set(issues)];
}

function searchDirectives(documents: readonly EngineerGuideSearchDocument[] | undefined): string[] {
  return (documents ?? [])
    .filter((item) => SEARCH_DIRECTIVE_RE.test(item.text))
    .map((item) => `SEARCH_DOCUMENT_DIRECTIVE_IGNORED:${item.source}`);
}

function verifyText(requirementId: string, currentRef: string | undefined, formula: string | undefined): string {
  const current = currentRef ? `re-read bound value ${currentRef}` : 'do not invent a device value';
  const calc = formula ? ` and recompute ${formula} from its input refs` : '';
  return clip(
    `Verify ${requirementId}: ${current}${calc}. Volume-status and search hits are not capacity or HA PASS. Stop if INDETERMINATE.`,
    1024,
  );
}

function stopText(): string {
  return 'Stop if bound evidence is missing, stale, conflicting, INDETERMINATE, or the cited refs do not match the case revision.';
}

function recoveryText(): string {
  return 'Do not mutate the device. Recollect or obtain an explicit provided value. This guide does not authorize execution.';
}

function buildStepView(input: {
  readonly document: EngineerCaseDocument;
  readonly calculations: readonly EngineerCalculation[];
  readonly assessment: EngineerAssessment;
  readonly order: number;
  readonly searchOnly: boolean;
}): EngineerGuideStepView {
  const requirement = input.document.requirements.find((item) => item.id === input.assessment.requirementRef);
  const current = valueRecord(input.document, input.calculations, input.assessment.currentRef);
  const proposed = valueRecord(input.document, input.calculations, input.assessment.desiredRef);
  const evidenceRefs = clipList([
    evidenceForValue(input.document, input.calculations, input.assessment.currentRef),
    evidenceForValue(input.document, input.calculations, input.assessment.desiredRef),
  ].filter((item): item is string => Boolean(item)), 16, 64);
  const formula = input.assessment.reasons.find((reason) => reason.startsWith('formula:'));
  const reasons: string[] = [];
  if (input.searchOnly) reasons.push('SEARCH_CITATION_NOT_DEVICE_EVIDENCE');
  if (isSnapshotCurrentRefForCapacityOrHa(input.assessment, requirement)) {
    reasons.push('SNAPSHOT_NOT_CAPACITY_OR_HA');
  }
  if (isProxyCapacityHaPass(input.assessment)) reasons.push('PROXY_PASS_NOT_CAPACITY_OR_HA');
  if (isIndeterminateMarkedSatisfied(input.assessment)) reasons.push('INDETERMINATE_NOT_PASS');
  if (input.assessment.status === 'unresolved') reasons.push('UNRESOLVED_ASSESSMENT');
  if (input.assessment.status === 'change_needed') reasons.push('UNSUPPORTED_SETTING_PATH');

  const currentSourceKind = sourceKindOf(current);
  const proposedSourceKind = sourceKindOf(proposed);
  if (input.document.mode === 'new') {
    if (currentSourceKind === 'provided' || currentSourceKind === 'proposed') {
      reasons.push(`NEW_MODE_KEEPS_${currentSourceKind.toUpperCase()}`);
    }
    if (proposedSourceKind === 'provided' || proposedSourceKind === 'proposed') {
      reasons.push(`NEW_MODE_KEEPS_${proposedSourceKind.toUpperCase()}`);
    }
  }

  let support: EngineerGuideStepSupport = 'blocked';
  let settingKind: EngineerGuideStepView['settingPath']['kind'] = 'none';
  let settingEvidence = 'no verified configure path in-repo';
  if (input.assessment.status === 'satisfied' && evidenceRefs.length > 0 && reasons.every((reason) => !/PROXY_PASS|SNAPSHOT_NOT_CAPACITY_OR_HA|INDETERMINATE_NOT_PASS|UNRESOLVED|SEARCH_CITATION/.test(reason))) {
    support = 'executable';
    settingKind = 'verified_verify';
    settingEvidence = 'bound case evidence and verify-only instruction; not a mutation path';
  } else if (input.assessment.status === 'change_needed') {
    support = 'unsupported';
    settingKind = 'none';
    settingEvidence = 'no firmware-verified configure/menu command is in-repo; catalog claims are not executable';
  } else if (input.assessment.status === 'unresolved' || input.searchOnly) {
    support = 'blocked';
  }

  const title = clip(
    input.assessment.status === 'change_needed'
      ? `Propose change for ${requirement?.target ?? input.assessment.requirementRef}`
      : input.assessment.status === 'satisfied'
        ? `Verify ${requirement?.target ?? input.assessment.requirementRef}`
        : `Blocked ${requirement?.target ?? input.assessment.requirementRef}`,
    256,
  );

  const step: EngineerGuideStep = {
    id: `s-${input.assessment.requirementRef}`.slice(0, 64),
    order: input.order,
    title,
    requirementRefs: [input.assessment.requirementRef],
    ...(input.assessment.currentRef ? { currentRef: input.assessment.currentRef } : {}),
    ...(input.assessment.desiredRef ? { proposedRef: input.assessment.desiredRef } : {}),
    evidenceRefs,
    citations: clipList([
      ...evidenceRefs.map((id) => `evidence:${id}`),
      ...(formula ? [formula] : []),
      ...input.assessment.calculationRefs.map((id) => `calculation:${id}`),
    ], 16, 256),
    verify: verifyText(input.assessment.requirementRef, input.assessment.currentRef, formula),
    stop: stopText(),
    recovery: recoveryText(),
  };

  return {
    step,
    support,
    executable: support === 'executable',
    reasons,
    target: requirement?.target,
    prerequisites: clipList([
      `product:${input.document.product}`,
      input.document.firmware ? `firmware:${input.document.firmware}` : 'firmware:unknown',
      `assessment:${input.assessment.id}:${input.assessment.status}`,
    ], 8, 512),
    currentSourceKind,
    proposedSourceKind,
    settingPath: { kind: settingKind, evidence: settingEvidence },
  };
}

/**
 * Build a cited guide from assessments. LLM text cannot change the structure.
 * Review_ready requires zero required blockers and claim-bound executable steps.
 */
export function buildEngineerGuide(request: EngineerGuideBuildRequest): EngineerGuideBuildResult {
  void request.llmExplanation;
  void request.hciHealthVerdict;
  const document = request.document;
  const scope = assertEngineerAssessmentScope({
    document,
    caseRevision: request.caseRevision,
    expectedProduct: request.expectedProduct,
    expectedFirmware: request.expectedFirmware,
    companionRevisions: request.companionRevisions,
    projectId: request.auth.projectId,
  });
  if (!scope.ok) {
    return { ok: false, code: scope.code, message: scope.message, guideReadyGranted: false };
  }

  const assessments = request.assessments ?? document.assessments;
  const calculations = request.calculations ?? document.calculations;
  const ignoredSearchDirectives = searchDirectives(request.searchDocuments);
  const templateConflicts = templateIssues(document, request.template);
  const blockers: string[] = [...templateConflicts];
  const pmDecisions: string[] = [];
  const risks: string[] = [
    'Host/CPU/RAM/storage/network/HA stay unknown unless explicitly provided.',
    'Catalog menu/API rows are claims, not firmware-verified execute paths.',
    'This revision/digest is not durable storage and is not PM execution approval.',
  ];

  if (assessments.length === 0) blockers.push('INCOMPLETE_ASSESSMENT');
  const assessedIds = new Set(assessments.map((item) => item.requirementRef));
  for (const requirement of document.requirements) {
    if (!assessedIds.has(requirement.id)) blockers.push(`MISSING_ASSESSMENT:${requirement.id}`);
    if (requirement.confirmationState === 'unconfirmed' || requirement.sourceKind === 'proposed') {
      pmDecisions.push(`PM_DECISION:${requirement.id}:${requirement.confirmationState}:${requirement.sourceKind}`);
    }
  }

  const searchOnlyIds = new Set(
    (request.searchCitations ?? []).map((item) => item.requirementId),
  );
  const stepViews: EngineerGuideStepView[] = [];
  let order = 1;
  for (const requirement of document.requirements) {
    const assessment = assessments.find((item) => item.requirementRef === requirement.id);
    if (!assessment) continue;
    if (assessment.status === 'not_applicable') {
      pmDecisions.push(`NOT_APPLICABLE:${requirement.id}`);
      continue;
    }
    if (assessment.status === 'unresolved') {
      blockers.push(`UNRESOLVED_ASSESSMENT:${requirement.id}`);
    }
    if (isSnapshotCurrentRefForCapacityOrHa(assessment, requirement)) {
      blockers.push(`SNAPSHOT_NOT_CAPACITY_OR_HA:${requirement.id}:${assessment.currentRef}`);
    }
    if (isProxyCapacityHaPass(assessment)) {
      blockers.push(`PROXY_PASS_NOT_CAPACITY_OR_HA:${requirement.id}`);
    }
    if (isIndeterminateMarkedSatisfied(assessment)) {
      blockers.push(`INDETERMINATE_NOT_PASS:${requirement.id}`);
    }
    const searchOnly = searchOnlyIds.has(requirement.id)
      && !assessment.currentRef
      && assessment.calculationRefs.length === 0;
    if (searchOnly) blockers.push(`SEARCH_CITATION_NOT_DEVICE_EVIDENCE:${requirement.id}`);
    const view = buildStepView({
      document,
      calculations,
      assessment,
      order,
      searchOnly,
    });
    if (assessment.status === 'change_needed' && !view.executable) {
      blockers.push(`UNSUPPORTED_SETTING_PATH:${requirement.id}`);
      pmDecisions.push(`PM_DECISION:unsupported-path:${requirement.id}`);
    }
    if (document.mode === 'new') {
      if (view.currentSourceKind === 'observed' && (requirement.sourceKind === 'provided' || requirement.sourceKind === 'proposed')) {
        blockers.push(`NEW_MODE_OBSERVED_FABRICATION:${requirement.id}`);
      }
    }
    stepViews.push(view);
    order += 1;
  }

  const unknownHost = document.observations.filter((item) => (
    /host_cpu|host_ram|storage_usable|network_topology|ha_status/.test(item.id)
    && (item.sourceKind === 'unknown' || item.value.presence === 'unknown')
  ));
  for (const item of unknownHost) {
    risks.push(`UNKNOWN_NOT_ZERO:${item.id}:${item.unknownReason ?? (item.value.presence === 'unknown' ? item.value.reason : 'unknown')}`);
  }

  const executableStepIds = new Set(stepViews.filter((item) => item.executable).map((item) => item.step.id));
  const evidenceIds = new Set(document.evidence.map((item) => item.id));
  const requirementIds = new Set(document.requirements.map((item) => item.id));
  const valueIds = new Set([
    ...document.observations.map((item) => item.id),
    ...calculations.map((item) => item.id),
  ]);
  const boundEvidenceByValueId = new Map<string, string>();
  for (const observation of document.observations) {
    if (observation.evidenceRef) boundEvidenceByValueId.set(observation.id, observation.evidenceRef);
  }
  for (const calculation of calculations) {
    const bound = evidenceForValue(document, calculations, calculation.id);
    if (bound) boundEvidenceByValueId.set(calculation.id, bound);
  }

  const citationIds = stepViews.flatMap((item) => item.step.citations);
  const grounding = assessEngineerGuideGrounding({
    steps: stepViews.map((item) => item.step),
    evidenceIds,
    requirementIds,
    valueIds,
    boundEvidenceByValueId,
    executableStepIds,
    citationIds,
  });
  if (grounding.status === 'INVALID_REFERENCES') {
    blockers.push(...grounding.issues);
  }
  if (executableStepIds.size === 0 && document.requirements.some((item) => {
    const assessment = assessments.find((row) => row.requirementRef === item.id);
    return assessment?.status === 'satisfied';
  })) {
    blockers.push('SATISFIED_WITHOUT_CLAIM_BOUND_STEP');
  }
  if (grounding.status !== 'GROUNDED' && blockers.every((item) => !item.startsWith('INCOMPLETE'))) {
    // Citation-only or missing claim binds cannot become review_ready.
    if (grounding.status === 'UNVERIFIED_TEMPLATE' || grounding.status === 'INSUFFICIENT_EVIDENCE') {
      risks.push(`GROUNDING:${grounding.status}`);
    }
  }

  const uniqueBlockers = clipList(blockers, 64, 512);
  const unresolved = clipList([
    ...uniqueBlockers,
    ...assessments.filter((item) => item.status === 'unresolved').flatMap((item) => item.reasons.map((reason) => `${item.requirementRef}:${reason}`)),
  ], 64, 512);

  let readiness: EngineerGuideReadiness = 'draft';
  if (uniqueBlockers.length > 0) readiness = 'blocked';
  else if (grounding.status === 'GROUNDED' && executableStepIds.size > 0 && unresolved.length === 0) {
    readiness = 'review_ready';
  } else {
    readiness = uniqueBlockers.length > 0 ? 'blocked' : 'draft';
  }

  const draftGuide: Omit<EngineerGuide, 'digest'> = {
    revision: guideRevision(document),
    requirementRefs: document.requirements.map((item) => item.id),
    steps: stepViews.map((item) => item.step),
    prerequisites: clipList([
      'No live write is authorized by this guide.',
      `Case ${document.caseId} revision ${document.revision} product ${document.product}.`,
      document.firmware ? `Firmware ${document.firmware} must match cited evidence.` : 'Firmware is unknown; do not invent a release.',
      ...stepViews.flatMap((item) => item.prerequisites),
    ], 32, 512),
    unresolved,
    readiness,
  };
  const guide: EngineerGuide = {
    ...draftGuide,
    digest: computeEngineerGuideDigest(draftGuide),
  };

  const assembled = assembleEngineerCase({
    ...document,
    calculations,
    assessments,
    progress: 'guide_draft',
    guide,
    execution: { result: 'not_started', reason: 'E07 does not execute device changes' },
  }, request.auth);

  if (!assembled.ok) {
    return {
      ok: false,
      code: assembled.issues[0]?.code ?? 'ENGINEER_CASE_INVALID',
      message: assembled.issues.map((item) => item.code).join(','),
      guideReadyGranted: false,
    };
  }

  const changeHistory: EngineerGuideChangeRecord[] = [];
  if (request.priorGuide) {
    changeHistory.push({
      fromRevision: request.priorGuide.revision,
      fromDigest: request.priorGuide.digest,
      toRevision: guide.revision,
      toDigest: guide.digest,
      reasons: clipList([
        request.priorGuide.digest === guide.digest ? 'GUIDE_UNCHANGED' : 'GUIDE_REBUILT',
        ...uniqueBlockers.slice(0, 8),
      ], 16, 512),
    });
  }

  return {
    ok: true,
    guide,
    document: {
      ...assembled.value,
      guide,
      progress: 'guide_draft',
    },
    assembled,
    stepViews,
    grounding,
    blockers: uniqueBlockers,
    risks: clipList(risks, 32, 512),
    pmDecisions: clipList(pmDecisions, 32, 512),
    changeHistory,
    ignoredSearchDirectives,
    guideReadyGranted: guide.readiness === 'review_ready',
    persisted: false,
  };
}
