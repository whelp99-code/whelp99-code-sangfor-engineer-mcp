/**
 * Join current state, requirements, and calculations into assessments (E06).
 *
 * Host/CPU/RAM/storage/network/HA stay unknown unless explicitly provided.
 * Volume-status health is not capacity/HA PASS. Compare never grants guide ready.
 */
import {
  assertEngineerAssessmentScope,
  isHciRequiredFieldId,
  snapshotObservationIsNotCapabilityRow,
} from '../../sangfor-config-state/src/engineer-assessment-scope.js';
import {
  HCI_E03B_CAPABILITIES,
  type HciE03bFieldId,
  type HciRequiredObservationResult,
} from '../../sangfor-hci-client/src/required-observations.js';
import { assessHciCapacityOrHaFromInventory } from '../../sangfor-hci-client/src/ops-monitor.js';
import {
  evaluateEngineerFormula,
  evaluateUnsupportedHaCapacity,
  operandFromCalculation,
  operandFromObservation,
  type EngineerFormulaId,
  type EngineerFormulaRole,
} from '../../sangfor-sizing/src/engineer-calculations.js';
import { convertEngineerUnit } from '../../sangfor-sizing/src/engineer-formulas.js';
import {
  evaluateDerivedFitness,
  type SourcedCalculationBaseline,
} from '../../sangfor-spec/src/derived-fitness.js';
import {
  evaluateEngineerRequirementCompare,
  parseEngineerConstraint,
  type EngineerParsedConstraint,
} from '../../sangfor-spec/src/engineer-compare.js';
import type {
  EngineerAssessment,
  EngineerCalculation,
  EngineerCaseDocument,
  EngineerObservation,
  EngineerRequirement,
  EngineerUnit,
  EngineerValue,
} from '../../shared/src/engineer-case-contract.js';
import { assembleEngineerCase, type EngineerCaseAssembly } from './engineer-case.js';

export type EngineerAssessmentBinding = {
  readonly requirementId: string;
  readonly currentRef?: string;
  readonly currentRefs?: readonly string[];
  readonly desiredRef?: string;
  readonly calculationRefs?: readonly string[];
  readonly fieldId?: HciE03bFieldId | 'volume_status';
  readonly formulaId?: EngineerFormulaId;
  readonly formulaRoles?: Partial<Record<EngineerFormulaRole, string>>;
  readonly fitnessBaseline?: SourcedCalculationBaseline;
  readonly baselineFromSearch?: boolean;
  readonly explicitlyNotApplicable?: boolean;
  readonly notApplicableReason?: string;
};

export type EngineerAssessmentSearchCitation = {
  readonly requirementId: string;
  readonly source: string;
};

export type EngineerCaseCoverage = {
  readonly requiredCount: number;
  readonly assessedCount: number;
  readonly satisfiedCount: number;
  readonly changeNeededCount: number;
  readonly unresolvedCount: number;
  readonly notApplicableCount: number;
  readonly trackingRate: number;
  readonly satisfactionRate: number;
  readonly unresolvedReasons: readonly string[];
};

export type EngineerProductMaturity = {
  readonly scope: 'not-this-case-coverage';
  readonly automaticHostNetworkHaCollection: 'unsupported';
  readonly fieldAcceptanceBlockersResolved: false;
  readonly note: string;
};

export type EngineerAssessmentRequest = {
  readonly document: EngineerCaseDocument;
  readonly auth: { readonly tenantId: string; readonly projectId: string; readonly actorId: string };
  readonly caseRevision: string;
  readonly now?: string;
  readonly expectedProduct?: EngineerCaseDocument['product'];
  readonly expectedFirmware?: string;
  readonly companionRevisions?: readonly string[];
  readonly bindings?: readonly EngineerAssessmentBinding[];
  readonly requiredObservations?: Pick<
    HciRequiredObservationResult,
    'fields' | 'capabilities' | 'acquisition' | 'guideReadyGranted' | 'fieldAcceptanceBlockersResolved'
  >;
  readonly inventory?: { readonly servers: readonly unknown[]; readonly volumes: readonly { id: string; name: string; status: string; size: number; description: string | null }[] };
  readonly hciHealthVerdict?: 'PASS' | 'FAIL' | 'INDETERMINATE';
  readonly searchCitations?: readonly EngineerAssessmentSearchCitation[];
  readonly priorAssessments?: readonly EngineerAssessment[];
  readonly priorCaseRevision?: string;
};

export type EngineerAssessmentSuccess = {
  readonly ok: true;
  readonly assessments: readonly EngineerAssessment[];
  readonly calculations: readonly EngineerCalculation[];
  readonly coverage: EngineerCaseCoverage;
  readonly productMaturity: EngineerProductMaturity;
  readonly assembled: EngineerCaseAssembly;
  readonly guideReadyGranted: false;
};

export type EngineerAssessmentFailure = {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly guideReadyGranted: false;
};

export type EngineerAssessmentResult = EngineerAssessmentSuccess | EngineerAssessmentFailure;

const CAPACITY_HA_FIELDS = new Set<string>(['storage_usable_capacity', 'ha_status', 'host_cpu', 'host_ram']);

function bindingFor(
  requirement: EngineerRequirement,
  bindings: readonly EngineerAssessmentBinding[] | undefined,
): EngineerAssessmentBinding {
  return bindings?.find((item) => item.requirementId === requirement.id) ?? { requirementId: requirement.id };
}

function inferFieldId(requirement: EngineerRequirement, binding: EngineerAssessmentBinding): HciE03bFieldId | 'volume_status' | undefined {
  if (binding.fieldId) return binding.fieldId;
  const text = `${requirement.target ?? ''} ${requirement.constraint ?? ''} ${requirement.acceptanceCriterion}`.toLowerCase();
  if (/\bha\b|고가용/.test(text)) return 'ha_status';
  if (/headroom|utilization|여유|사용률/.test(text)) return 'storage_usable_capacity';
  if (/usable|storage|용량|storage_usable/.test(text)) return 'storage_usable_capacity';
  if (/\bcpu\b/.test(text)) return 'host_cpu';
  if (/\bram\b|memory|메모리/.test(text)) return 'host_ram';
  if (/network|네트워크/.test(text)) return 'network_topology';
  return undefined;
}

function inferFormulaId(requirement: EngineerRequirement, binding: EngineerAssessmentBinding): EngineerFormulaId | undefined {
  if (binding.formulaId) return binding.formulaId;
  const text = `${requirement.constraint ?? ''} ${requirement.acceptanceCriterion}`.toLowerCase();
  if (/headroom|여유량/.test(text)) return 'demand-headroom';
  if (/utilization|사용률/.test(text)) return 'confirmed-utilization-ratio';
  if (/remaining|잔여/.test(text)) return 'confirmed-remaining-capacity';
  return undefined;
}

function observationById(document: EngineerCaseDocument, id: string | undefined): EngineerObservation | undefined {
  if (!id) return undefined;
  return document.observations.find((item) => item.id === id);
}

function candidateCurrentIds(
  document: EngineerCaseDocument,
  binding: EngineerAssessmentBinding,
  fieldId: string | undefined,
): string[] {
  const ids = [
    ...binding.currentRefs ?? [],
    ...(binding.currentRef ? [binding.currentRef] : []),
  ];
  if (ids.length === 0 && fieldId) {
    const prefix = `obs-${fieldId}`;
    for (const observation of document.observations) {
      if (observation.id === prefix || observation.id.startsWith(`${prefix}-`)) ids.push(observation.id);
    }
  }
  return [...new Set(ids)];
}

function valuesConflict(values: readonly EngineerValue[]): boolean {
  const known = values.filter((item) => item.presence === 'known').map((item) => JSON.stringify(item.data));
  return new Set(known).size > 1;
}

function freshnessIssue(observation: EngineerObservation, now: string | undefined): string | undefined {
  if (observation.collectionStatus !== 'complete') {
    return `INCOMPLETE_INPUT:${observation.id}:${observation.collectionStatus}`;
  }
  if (!observation.freshnessPolicy) return undefined;
  if (now === undefined) return `ASSESSMENT_TIME_MISSING:${observation.id}`;
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) return `ASSESSMENT_TIME_INVALID:${observation.id}`;
  if (!observation.collectedAt) return `FRESHNESS_UNPROVEN:${observation.id}`;
  const capturedMs = Date.parse(observation.collectedAt);
  if (!Number.isFinite(capturedMs)) return `FRESHNESS_UNPROVEN:${observation.id}`;
  const ageSec = (nowMs - capturedMs) / 1000;
  if (ageSec < 0) return `EVIDENCE_FUTURE:${observation.id}`;
  if (ageSec > observation.freshnessPolicy.maxAgeSec) return `STALE_INPUT:${observation.id}`;
  return undefined;
}

function convertKnownToUnit(value: EngineerValue, unit: EngineerUnit): EngineerValue {
  if (value.presence !== 'known') return value;
  const data = value.data;
  if (data.kind !== 'number' && data.kind !== 'integer') return value;
  const number = data.kind === 'number' ? data.number : data.integer;
  const from = data.unit;
  if (!from || from === unit) return value;
  const converted = convertEngineerUnit(number, from, unit);
  if (!converted.ok) return { presence: 'unknown', reason: `${converted.reason}:${from}:${unit}` };
  return { presence: 'known', data: { kind: 'number', number: converted.value, unit } };
}

function nextActionFor(
  status: EngineerAssessment['status'],
  reasons: readonly string[],
  requirement: EngineerRequirement,
): EngineerAssessment['nextAction'] {
  if (status === 'satisfied' || status === 'not_applicable') return 'none';
  if (status === 'change_needed') return 'config_change';
  const joined = reasons.join(' ');
  if (/STALE_INPUT|INCOMPLETE_INPUT|FRESHNESS_|EVIDENCE_FUTURE|RECOLLECT/.test(joined)) return 'recollect';
  if (/CONFLICT|UNCONFIRMED|UNSUPPORTED_HA|UNPARSEABLE|DESIGN/.test(joined)) return 'design_decision';
  if (requirement.sourceKind === 'proposed' || requirement.confirmationState === 'unconfirmed') {
    if (/UNCONFIRMED|PROPOSED/.test(joined)) return 'design_decision';
  }
  return 'add_information';
}

function capabilityNotes(
  fieldId: HciE03bFieldId | undefined,
  required: EngineerAssessmentRequest['requiredObservations'],
): string[] {
  if (!fieldId || !isHciRequiredFieldId(fieldId)) return [];
  const field = required?.fields.find((item) => item.id === fieldId);
  const capability = (required?.capabilities ?? HCI_E03B_CAPABILITIES).find((item) => item.fieldId === fieldId);
  const notes = [
    field ? `capability:${field.id}:acquisition=${field.acquisition}:completeness=${field.completeness}` : undefined,
    field?.permission ? `permission:${field.permission}` : capability ? `permission:${capability.permission}` : undefined,
    field?.evidence ? `evidence:${field.evidence}` : capability ? `evidence:${capability.evidence}` : undefined,
    field?.collectionPath === null || capability?.collectionPath === null ? 'collectionPath:null' : undefined,
    field ? `firmwareSupport:${field.firmwareSupport}` : capability ? `firmwareSupport:${capability.firmwareSupport}` : undefined,
  ].filter((item): item is string => Boolean(item));
  return notes;
}

function productMaturity(required: EngineerAssessmentRequest['requiredObservations']): EngineerProductMaturity {
  return {
    scope: 'not-this-case-coverage',
    automaticHostNetworkHaCollection: 'unsupported',
    fieldAcceptanceBlockersResolved: false,
    note: required
      ? `E03B automatic collection remains unsupported; case coverage is not product maturity. blockersResolved=${required.fieldAcceptanceBlockersResolved}`
      : 'E03B host/CPU/RAM/storage/network/HA automatic collection is unsupported unless a value is explicitly provided',
  };
}

function clipReasons(reasons: readonly string[]): string[] {
  return reasons
    .map((reason) => (reason.length <= 512 ? reason : `${reason.slice(0, 509)}...`))
    .filter((reason) => reason.length > 0)
    .slice(0, 16);
}

function coverageOf(assessments: readonly EngineerAssessment[], requiredCount: number): EngineerCaseCoverage {
  const satisfiedCount = assessments.filter((item) => item.status === 'satisfied').length;
  const changeNeededCount = assessments.filter((item) => item.status === 'change_needed').length;
  const unresolvedCount = assessments.filter((item) => item.status === 'unresolved').length;
  const notApplicableCount = assessments.filter((item) => item.status === 'not_applicable').length;
  return {
    requiredCount,
    assessedCount: assessments.length,
    satisfiedCount,
    changeNeededCount,
    unresolvedCount,
    notApplicableCount,
    trackingRate: requiredCount === 0 ? 1 : assessments.length / requiredCount,
    satisfactionRate: requiredCount === 0 ? 0 : satisfiedCount / requiredCount,
    unresolvedReasons: assessments.filter((item) => item.status === 'unresolved').flatMap((item) => item.reasons),
  };
}

function assessmentId(requirementId: string): string {
  const id = `assess-${requirementId}`.slice(0, 64);
  return id;
}

function calcId(requirementId: string): string {
  return `calc-${requirementId}`.slice(0, 64);
}

function storedCalculationForCompare(
  calculations: readonly EngineerCalculation[],
  requirement: EngineerRequirement,
  binding: EngineerAssessmentBinding,
): EngineerCalculation | undefined {
  const formulaId = inferFormulaId(requirement, binding);
  if (!formulaId) return undefined;
  const allowed = new Set(binding.calculationRefs ?? []);
  const pool = allowed.size > 0
    ? calculations.filter((item) => allowed.has(item.id))
    : calculations;
  return pool.find((item) => item.formulaId === formulaId);
}

function desiredFrom(
  requirement: EngineerRequirement,
  document: EngineerCaseDocument,
  binding: EngineerAssessmentBinding,
): { constraint: EngineerParsedConstraint; desiredRef?: string } {
  const desiredObs = observationById(document, binding.desiredRef);
  if (desiredObs?.value.presence === 'known') {
    const data = desiredObs.value.data;
    if (data.kind === 'boolean') {
      return { constraint: { kind: 'boolean', expected: data.boolean }, desiredRef: desiredObs.id };
    }
    if (data.kind === 'number') {
      return { constraint: { kind: 'numeric', op: 'eq', threshold: data.number, unit: data.unit }, desiredRef: desiredObs.id };
    }
    if (data.kind === 'integer' && data.unit) {
      return { constraint: { kind: 'numeric', op: 'eq', threshold: data.integer, unit: data.unit }, desiredRef: desiredObs.id };
    }
  }
  return { constraint: parseEngineerConstraint(requirement.constraint ?? requirement.acceptanceCriterion) };
}

/**
 * Assess every current requirement. Deleted-requirement assessments cannot be
 * reused as current. Compare success never grants guide ready.
 */
export function assessEngineerCase(request: EngineerAssessmentRequest): EngineerAssessmentResult {
  const document = request.document;
  const companion = [
    ...request.companionRevisions ?? [],
    ...(request.priorCaseRevision ? [request.priorCaseRevision] : []),
  ];
  const scope = assertEngineerAssessmentScope({
    document,
    caseRevision: request.caseRevision,
    expectedProduct: request.expectedProduct,
    expectedFirmware: request.expectedFirmware,
    companionRevisions: companion.length > 0 ? companion : undefined,
    priorAssessments: request.priorAssessments,
    projectId: request.auth.projectId,
  });
  if (!scope.ok) {
    return { ok: false, code: scope.code, message: scope.message, guideReadyGranted: false };
  }

  const calculations = [...document.calculations];
  const assessments: EngineerAssessment[] = [];

  for (const requirement of document.requirements) {
    const binding = bindingFor(requirement, request.bindings);
    const fieldId = inferFieldId(requirement, binding);
    const reasons: string[] = [];
    const calculationRefs = [...binding.calculationRefs ?? []];
    const searchCited = Boolean(request.searchCitations?.some((item) => item.requirementId === requirement.id));

    if (binding.explicitlyNotApplicable === true && binding.notApplicableReason) {
      assessments.push({
        id: assessmentId(requirement.id),
        caseId: document.caseId,
        projectId: request.auth.projectId,
        requirementRef: requirement.id,
        calculationRefs,
        status: 'not_applicable',
        reasons: [`NOT_APPLICABLE:${binding.notApplicableReason}`],
        nextAction: 'none',
      });
      continue;
    }

    if (fieldId && isHciRequiredFieldId(fieldId)) {
      reasons.push(...capabilityNotes(fieldId, request.requiredObservations));
      const requiredField = request.requiredObservations?.fields.find((item) => item.id === fieldId);
      if (requiredField && requiredField.acquisition !== 'manual-provided' && requiredField.value.presence !== 'known') {
        reasons.push(`E03B_UNSUPPORTED:${fieldId}:${requiredField.reason}`);
      }
    }

    const currentIds = candidateCurrentIds(document, binding, fieldId);
    const discoveredCurrent = currentIds.length > 0;
    if (currentIds.some((id) => snapshotObservationIsNotCapabilityRow(id, fieldId))) {
      assessments.push({
        id: assessmentId(requirement.id),
        caseId: document.caseId,
        projectId: request.auth.projectId,
        requirementRef: requirement.id,
        currentRef: currentIds[0],
        calculationRefs,
        status: 'unresolved',
        reasons: [...reasons, `SNAPSHOT_NOT_CAPABILITY_ROW:${currentIds.join(',')}:${String(fieldId)}`],
        nextAction: 'add_information',
      });
      continue;
    }

    const currentObs = currentIds.map((id) => observationById(document, id)).filter((item): item is EngineerObservation => Boolean(item));
    if (valuesConflict(currentObs.map((item) => item.value))) {
      assessments.push({
        id: assessmentId(requirement.id),
        caseId: document.caseId,
        projectId: request.auth.projectId,
        requirementRef: requirement.id,
        currentRef: currentIds[0],
        calculationRefs,
        status: 'unresolved',
        reasons: [...reasons, `CONFLICTING_OBSERVATION:${currentIds.join(',')}`],
        nextAction: 'design_decision',
      });
      continue;
    }

    const current = currentObs[0];
    const stale = current ? freshnessIssue(current, request.now) : undefined;
    const formulaId = inferFormulaId(requirement, binding);
    const desired = desiredFrom(requirement, document, binding);
    const capacityOrHa = Boolean(fieldId && CAPACITY_HA_FIELDS.has(fieldId))
      || formulaId !== undefined
      || /ha|capacity|headroom|잔여|용량/.test(`${requirement.target ?? ''} ${requirement.constraint ?? ''}`);

    if (capacityOrHa) {
      void request.hciHealthVerdict;
      if (request.inventory) {
        const inventoryFitness = assessHciCapacityOrHaFromInventory({
          servers: [...request.inventory.servers],
          volumes: [...request.inventory.volumes],
        });
        reasons.push(`capacity-or-ha:${inventoryFitness.verdict}:${inventoryFitness.reason}`);
      }
      if (fieldId === 'ha_status' && !current) {
        const ha = evaluateUnsupportedHaCapacity({
          id: calcId(requirement.id),
          caseId: document.caseId,
          projectId: request.auth.projectId,
        });
        reasons.push(ha.unavailableReason ?? 'UNSUPPORTED_HA_FORMULA');
        const knownIds = new Set([
          ...document.observations.map((item) => item.id),
          ...calculations.map((item) => item.id),
        ]);
        if (ha.inputRefs.every((id) => knownIds.has(id))) {
          calculations.push(ha);
          calculationRefs.push(ha.id);
        }
      }
    }

    const searchOnly = searchCited
      && !discoveredCurrent
      && calculationRefs.length === 0
      && !binding.formulaId
      && !binding.formulaRoles;
    if (searchOnly || binding.baselineFromSearch) {
      const compared = evaluateEngineerRequirementCompare({ searchOnly: true });
      assessments.push({
        id: assessmentId(requirement.id),
        caseId: document.caseId,
        projectId: request.auth.projectId,
        requirementRef: requirement.id,
        currentRef: current?.id,
        desiredRef: desired.desiredRef,
        calculationRefs,
        status: compared.status,
        reasons: clipReasons([
          ...reasons,
          compared.reason,
          ...((request.searchCitations ?? [])
            .filter((item) => item.requirementId === requirement.id)
            .map((item) => `search:${item.source}`)),
        ]),
        nextAction: 'add_information',
      });
      continue;
    }

    if (requirement.sourceKind === 'proposed' && requirement.confirmationState === 'unconfirmed') {
      assessments.push({
        id: assessmentId(requirement.id),
        caseId: document.caseId,
        projectId: request.auth.projectId,
        requirementRef: requirement.id,
        currentRef: current?.id,
        desiredRef: desired.desiredRef,
        calculationRefs,
        status: 'unresolved',
        reasons: [...reasons, 'UNCONFIRMED_PROPOSED_REQUIREMENT'],
        nextAction: 'design_decision',
      });
      continue;
    }

    if (formulaId && binding.formulaRoles) {
      const roles = Object.fromEntries(
        Object.entries(binding.formulaRoles).map(([role, ref]) => {
          const observation = observationById(document, ref);
          const calculation = calculations.find((item) => item.id === ref);
          const operand = observation
            ? operandFromObservation(observation)
            : calculation
              ? operandFromCalculation(calculation)
              : undefined;
          return [role, operand];
        }),
      ) as Partial<Record<EngineerFormulaRole, ReturnType<typeof operandFromObservation>>>;
      const calculated = evaluateEngineerFormula({
        id: calcId(requirement.id),
        caseId: document.caseId,
        projectId: request.auth.projectId,
        formulaId,
        roles,
        now: request.now,
      });
      calculations.push(calculated);
      calculationRefs.push(calculated.id);
      const baseline = binding.fitnessBaseline;
      const fitness = evaluateDerivedFitness({
        calculation: calculated,
        baseline: binding.baselineFromSearch ? undefined : baseline,
      });
      reasons.push(`formula:${calculated.formulaId}:${calculated.formulaVersion}:inputs=${calculated.inputRefs.join(',')}`);
      reasons.push(`fitness:${fitness.reasonCode}:${fitness.reason}`);
      const status = fitness.verdict === 'PASS'
        ? 'satisfied'
        : fitness.verdict === 'FAIL'
          ? 'change_needed'
          : 'unresolved';
      assessments.push({
        id: assessmentId(requirement.id),
        caseId: document.caseId,
        projectId: request.auth.projectId,
        requirementRef: requirement.id,
        currentRef: current?.id ?? binding.formulaRoles.total,
        desiredRef: desired.desiredRef,
        calculationRefs,
        status,
        reasons,
        nextAction: nextActionFor(status, reasons, requirement),
      });
      continue;
    }

    let compareCurrent = current?.value;
    let compareCurrentRef = current?.id;
    const storedCalc = storedCalculationForCompare(calculations, requirement, binding);
    if (storedCalc?.result && (!compareCurrent || compareCurrent.presence !== 'known')) {
      compareCurrent = storedCalc.result;
      compareCurrentRef = storedCalc.id;
      if (!calculationRefs.includes(storedCalc.id)) calculationRefs.push(storedCalc.id);
      reasons.push(`stored-calculation:${storedCalc.id}:${storedCalc.formulaId}`);
    }
    if (compareCurrent && desired.constraint.kind === 'numeric') {
      compareCurrent = convertKnownToUnit(compareCurrent, desired.constraint.unit);
    }

    const compared = evaluateEngineerRequirementCompare({
      current: compareCurrent,
      desired: desired.constraint.kind === 'unparseable' || desired.constraint.kind === 'not_applicable_text'
        ? desired.constraint
        : desired.constraint,
      freshnessIssue: storedCalc ? undefined : stale,
      conflicting: false,
      searchOnly: false,
    });
    if (desired.constraint.kind === 'not_applicable_text') {
      reasons.push('CANNOT_CONFIRM_IS_NOT_NOT_APPLICABLE');
    }
    if (desired.constraint.kind === 'unparseable') {
      reasons.push(desired.constraint.reason);
    }
    reasons.push(compared.reason);
    if (compareCurrentRef && storedCalc?.id === compareCurrentRef) {
      reasons.push(`current:${storedCalc.id}:derived:${storedCalc.formulaId}`);
    } else if (current) {
      reasons.push(`current:${current.id}:${current.sourceKind}:${current.collectionStatus}`);
      if (current.evidenceRef) reasons.push(`evidenceRef:${current.evidenceRef}`);
    }

    const status = compared.status;
    assessments.push({
      id: assessmentId(requirement.id),
      caseId: document.caseId,
      projectId: request.auth.projectId,
      requirementRef: requirement.id,
      currentRef: compareCurrentRef,
      desiredRef: desired.desiredRef,
      calculationRefs,
      status,
      reasons,
      nextAction: nextActionFor(status, reasons, requirement),
    });
  }

  const finalized = assessments.map((item) => ({ ...item, reasons: clipReasons(item.reasons) }));
  const requirementIds = new Set(document.requirements.map((item) => item.id));

  const assembled = assembleEngineerCase({
    ...document,
    progress: 'assessment_ready',
    calculations,
    assessments: finalized,
    guide: {
      ...document.guide,
      requirementRefs: document.requirements.map((item) => item.id),
      steps: document.guide.steps.map((step) => ({
        ...step,
        requirementRefs: step.requirementRefs.filter((id) => requirementIds.has(id)),
      })),
    },
  }, request.auth);

  if (!assembled.ok) {
    return {
      ok: false,
      code: assembled.issues[0]?.code ?? 'ENGINEER_CASE_INVALID',
      message: assembled.issues.map((item) => item.code).join(','),
      guideReadyGranted: false,
    };
  }

  return {
    ok: true,
    assessments: finalized,
    calculations,
    coverage: coverageOf(finalized, document.requirements.length),
    productMaturity: productMaturity(request.requiredObservations),
    assembled,
    guideReadyGranted: false,
  };
}

