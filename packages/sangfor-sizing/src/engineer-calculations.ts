/**
 * Deterministic engineer-case arithmetic (E05).
 *
 * Pure functions only. LLM arithmetic is never stored as a formula result.
 * Unknown stays unknown. A derived zero keeps formulaId/formulaVersion/inputRefs.
 * These results never grant guide review_ready and are not a live write path.
 */
import type {
  EngineerCalculation,
  EngineerCollectionStatus,
  EngineerObservation,
  EngineerSourceKind,
  EngineerUnit,
  EngineerValue,
} from '../../shared/src/engineer-case-contract.js';
import {
  ENGINEER_FORMULA_CATALOG,
  convertEngineerUnit,
  isEngineerFormulaId,
  roundHalfAway,
  type EngineerFormulaId,
  type EngineerFormulaRole,
} from './engineer-formulas.js';

export type { EngineerFormulaId, EngineerFormulaRole } from './engineer-formulas.js';
export {
  ENGINEER_FORMULA_CATALOG,
  ENGINEER_FORMULA_IDS,
  convertEngineerUnit,
  isEngineerFormulaId,
  roundHalfAway,
} from './engineer-formulas.js';

export type EngineerFormulaOperand = {
  readonly id: string;
  readonly sourceKind: EngineerSourceKind;
  readonly value: EngineerValue;
  readonly collectionStatus: EngineerCollectionStatus;
  readonly collectedAt?: string;
  readonly freshnessPolicy?: { readonly maxAgeSec: number };
  readonly unavailableReason?: string;
};

export type EngineerFormulaRequest = {
  readonly id: string;
  readonly formulaId: EngineerFormulaId;
  readonly formulaVersion?: string;
  readonly caseId?: string;
  readonly projectId?: string;
  readonly roles: Partial<Record<EngineerFormulaRole, EngineerFormulaOperand>>;
  readonly now?: string;
  readonly outputUnit?: EngineerUnit;
  readonly maxFutureSkewSec?: number;
};

export function operandFromObservation(observation: EngineerObservation): EngineerFormulaOperand {
  return {
    id: observation.id,
    sourceKind: observation.sourceKind,
    value: observation.value,
    collectionStatus: observation.collectionStatus,
    collectedAt: observation.collectedAt,
    freshnessPolicy: observation.freshnessPolicy,
    unavailableReason: observation.unknownReason,
  };
}

export function operandFromCalculation(calculation: EngineerCalculation): EngineerFormulaOperand {
  const result = calculation.result ?? {
    presence: 'unknown' as const,
    reason: calculation.unavailableReason ?? 'prior calculation unavailable',
  };
  return {
    id: calculation.id,
    sourceKind: calculation.sourceKind,
    value: result,
    collectionStatus: calculation.sourceKind === 'derived' && result.presence === 'known' ? 'complete' : 'missing',
    unavailableReason: calculation.unavailableReason,
  };
}

function unavailable(
  request: Pick<EngineerFormulaRequest, 'id' | 'caseId' | 'projectId'>,
  formulaId: string,
  formulaVersion: string,
  inputRefs: readonly string[],
  reason: string,
  assumptions: readonly string[] = [],
): EngineerCalculation {
  const refs = inputRefs.length > 0 ? inputRefs : [formulaId];
  return {
    id: request.id,
    caseId: request.caseId,
    projectId: request.projectId,
    sourceKind: 'unknown',
    formulaId,
    formulaVersion,
    inputRefs: refs,
    assumptions: [...assumptions],
    result: { presence: 'unknown', reason },
    unavailableReason: reason,
  };
}

function derived(
  request: Pick<EngineerFormulaRequest, 'id' | 'caseId' | 'projectId'>,
  formulaId: EngineerFormulaId,
  formulaVersion: string,
  inputRefs: readonly string[],
  value: number,
  unit: EngineerUnit,
  assumptions: readonly string[],
): EngineerCalculation {
  return {
    id: request.id,
    caseId: request.caseId,
    projectId: request.projectId,
    sourceKind: 'derived',
    formulaId,
    formulaVersion,
    inputRefs: [...inputRefs],
    unit,
    assumptions: [...assumptions],
    result: { presence: 'known', data: { kind: 'number', number: value, unit } },
  };
}

function collectedInputRefs(
  roles: Partial<Record<EngineerFormulaRole, EngineerFormulaOperand>>,
  required: readonly EngineerFormulaRole[],
): string[] {
  return required.map((role) => roles[role]?.id ?? role);
}

function missingRoles(
  roles: Partial<Record<EngineerFormulaRole, EngineerFormulaOperand>>,
  required: readonly EngineerFormulaRole[],
): EngineerFormulaRole[] {
  return required.filter((role) => {
    const operand = roles[role];
    if (!operand) return true;
    if (operand.sourceKind === 'unknown') return true;
    if (operand.value.presence === 'unknown') return true;
    if (operand.unavailableReason && operand.sourceKind !== 'derived') return true;
    return false;
  });
}

type NumericOperand = {
  readonly id: string;
  readonly number: number;
  readonly unit: EngineerUnit;
};

function readNumeric(operand: EngineerFormulaOperand): NumericOperand | { reason: string } {
  if (operand.value.presence !== 'known') {
    return { reason: `MISSING_INPUTS:${operand.id}` };
  }
  const data = operand.value.data;
  if (data.kind === 'number') {
    if (!Number.isFinite(data.number)) return { reason: `INVALID_NUMBER:${operand.id}` };
    return { id: operand.id, number: data.number, unit: data.unit };
  }
  if (data.kind === 'integer') {
    if (!Number.isFinite(data.integer)) return { reason: `INVALID_NUMBER:${operand.id}` };
    if (!data.unit) return { reason: `UNIT_MISSING:${operand.id}` };
    return { id: operand.id, number: data.integer, unit: data.unit };
  }
  return { reason: `NON_NUMERIC_VALUE:${operand.id}` };
}

function freshnessIssue(
  operand: EngineerFormulaOperand,
  now: string | undefined,
  maxFutureSkewSec: number,
): string | undefined {
  if (operand.collectionStatus !== 'complete') {
    return `INCOMPLETE_INPUT:${operand.id}:${operand.collectionStatus}`;
  }
  if (!operand.freshnessPolicy) return undefined;
  if (now === undefined) return `ASSESSMENT_TIME_MISSING:${operand.id}`;
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) return `ASSESSMENT_TIME_INVALID:${operand.id}`;
  if (!Number.isFinite(maxFutureSkewSec) || maxFutureSkewSec < 0) {
    return `FRESHNESS_POLICY_INVALID:${operand.id}`;
  }
  if (!operand.collectedAt) return `FRESHNESS_UNPROVEN:${operand.id}`;
  const capturedMs = Date.parse(operand.collectedAt);
  if (!Number.isFinite(capturedMs)) return `FRESHNESS_UNPROVEN:${operand.id}`;
  const ageSec = (nowMs - capturedMs) / 1000;
  if (ageSec < -maxFutureSkewSec) return `EVIDENCE_FUTURE:${operand.id}`;
  if (ageSec > operand.freshnessPolicy.maxAgeSec) return `STALE_INPUT:${operand.id}`;
  return undefined;
}

function convertRole(
  operand: NumericOperand,
  outputUnit: EngineerUnit,
  assumptions: string[],
): { readonly value: number } | { readonly reason: string } {
  const converted = convertEngineerUnit(operand.number, operand.unit, outputUnit);
  if (!converted.ok) return { reason: `${converted.reason}:${operand.id}` };
  if (converted.converted) {
    assumptions.push(`unit-conversion: ${operand.id} ${operand.number} ${operand.unit} -> ${converted.value} ${outputUnit}`);
  }
  return { value: converted.value };
}

export function evaluateEngineerFormula(request: EngineerFormulaRequest): EngineerCalculation {
  const catalog = isEngineerFormulaId(request.formulaId)
    ? ENGINEER_FORMULA_CATALOG[request.formulaId]
    : undefined;
  const formulaVersion = catalog?.version ?? request.formulaVersion ?? '0.0.0';
  const required = catalog?.roles ?? (['total', 'used'] as const);
  const inputRefs = collectedInputRefs(request.roles, required);

  if (!catalog) {
    return unavailable(request, request.formulaId, formulaVersion, inputRefs, `UNSUPPORTED_FORMULA:${request.formulaId}`);
  }
  if (request.formulaVersion !== undefined && request.formulaVersion !== catalog.version) {
    return unavailable(
      request,
      request.formulaId,
      catalog.version,
      inputRefs,
      `UNSUPPORTED_FORMULA_VERSION:${request.formulaId}:${request.formulaVersion}`,
    );
  }

  const missing = missingRoles(request.roles, required);
  if (missing.length > 0) {
    return unavailable(
      request,
      request.formulaId,
      catalog.version,
      inputRefs,
      `MISSING_INPUTS:${missing.join(',')}`,
    );
  }

  const assumptions: string[] = [];
  const operands = required.map((role) => request.roles[role]!);
  for (const operand of operands) {
    const issue = freshnessIssue(operand, request.now, request.maxFutureSkewSec ?? 0);
    if (issue) {
      return unavailable(request, request.formulaId, catalog.version, inputRefs, issue, assumptions);
    }
  }
  if (operands.some((operand) => !operand.freshnessPolicy)) {
    assumptions.push('freshness-not-proven: snapshot arithmetic; not a current complete observation');
  }

  const numeric: NumericOperand[] = [];
  for (const operand of operands) {
    const parsed = readNumeric(operand);
    if ('reason' in parsed) {
      return unavailable(request, request.formulaId, catalog.version, inputRefs, parsed.reason, assumptions);
    }
    if (parsed.number < 0) {
      return unavailable(request, request.formulaId, catalog.version, inputRefs, `NEGATIVE_INPUT:${parsed.id}`, assumptions);
    }
    numeric.push(parsed);
  }

  const [total, used, demand] = numeric;
  const outputUnit = catalog.resultKind === 'percent'
    ? 'percent'
    : request.outputUnit ?? total.unit;
  const convertedTotal = convertRole(total, catalog.resultKind === 'percent' ? total.unit : outputUnit, assumptions);
  if ('reason' in convertedTotal) {
    return unavailable(request, request.formulaId, catalog.version, inputRefs, convertedTotal.reason, assumptions);
  }
  const usedUnit = catalog.resultKind === 'percent' ? total.unit : outputUnit;
  const convertedUsed = convertRole(used, usedUnit, assumptions);
  if ('reason' in convertedUsed) {
    return unavailable(request, request.formulaId, catalog.version, inputRefs, convertedUsed.reason, assumptions);
  }
  let convertedDemand: { value: number } | undefined;
  if (demand) {
    const next = convertRole(demand, outputUnit, assumptions);
    if ('reason' in next) {
      return unavailable(request, request.formulaId, catalog.version, inputRefs, next.reason, assumptions);
    }
    convertedDemand = next;
  }

  if (request.formulaId === 'confirmed-utilization-ratio') {
    if (convertedTotal.value === 0) {
      return unavailable(request, request.formulaId, catalog.version, inputRefs, `DIVISION_BY_ZERO:${total.id}`, assumptions);
    }
    const raw = (convertedUsed.value / convertedTotal.value) * 100;
    if (!Number.isFinite(raw)) {
      return unavailable(request, request.formulaId, catalog.version, inputRefs, 'INVALID_NUMBER', assumptions);
    }
    if (convertedUsed.value > convertedTotal.value) assumptions.push('used-exceeds-total: utilization is above 100 percent');
    return derived(request, request.formulaId, catalog.version, inputRefs, roundHalfAway(raw, catalog.decimalScale), 'percent', assumptions);
  }

  const remaining = convertedTotal.value - convertedUsed.value;
  if (!Number.isFinite(remaining)) {
    return unavailable(request, request.formulaId, catalog.version, inputRefs, 'INVALID_NUMBER', assumptions);
  }
  if (convertedUsed.value > convertedTotal.value) assumptions.push('used-exceeds-total: remaining is negative');

  if (request.formulaId === 'confirmed-remaining-capacity') {
    const value = assumptions.some((item) => item.startsWith('unit-conversion:'))
      ? roundHalfAway(remaining, catalog.decimalScale)
      : remaining;
    return derived(request, request.formulaId, catalog.version, inputRefs, value, outputUnit, assumptions);
  }

  const headroom = remaining - (convertedDemand?.value ?? 0);
  if (!Number.isFinite(headroom)) {
    return unavailable(request, request.formulaId, catalog.version, inputRefs, 'INVALID_NUMBER', assumptions);
  }
  if ((convertedDemand?.value ?? 0) > remaining) assumptions.push('demand-exceeds-remaining: headroom is negative');
  const value = assumptions.some((item) => item.startsWith('unit-conversion:'))
    ? roundHalfAway(headroom, catalog.decimalScale)
    : headroom;
  return derived(request, request.formulaId, catalog.version, inputRefs, value, outputUnit, assumptions);
}

export function evaluateUnsupportedHaCapacity(request: {
  readonly id: string;
  readonly caseId?: string;
  readonly projectId?: string;
  readonly vmCount?: EngineerFormulaOperand;
  readonly nodeCount?: EngineerFormulaOperand;
  readonly officialTopology?: unknown;
  readonly officialFormulaCitation?: unknown;
}): EngineerCalculation {
  const inputRefs = [request.vmCount?.id, request.nodeCount?.id].filter((id): id is string => Boolean(id));
  return unavailable(
    request,
    'ha-n-plus-one-capacity',
    '0.0.0',
    inputRefs,
    'UNSUPPORTED_HA_FORMULA: N+1/replication/reservation requires exact topology and an official formula; VM or node count alone is not capacity or HA fitness',
    [
      request.officialTopology == null ? 'official-topology-missing' : 'official-topology-present-but-no-coded-formula',
      request.officialFormulaCitation == null ? 'official-formula-missing' : 'official-formula-citation-is-not-a-coded-formula',
    ],
  );
}

export function sizingTierIsNotOfficialFormula(result: { readonly tier: string }): {
  readonly advisory: true;
  readonly officialBom: false;
  readonly fitnessVerdict: 'INDETERMINATE';
  readonly guideReadyGranted: false;
  readonly reason: string;
} {
  return {
    advisory: true,
    officialBom: false,
    fitnessVerdict: 'INDETERMINATE',
    guideReadyGranted: false,
    reason: result.tier === 'unsourced'
      ? 'SIZING_UNSOURCED: no sourced threshold; cannot grant capacity PASS'
      : 'SIZING_ADVISORY: heuristic tier is not an official BOM or capacity fitness PASS',
  };
}
