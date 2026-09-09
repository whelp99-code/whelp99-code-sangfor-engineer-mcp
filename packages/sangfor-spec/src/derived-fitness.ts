/**
 * Fitness check for an E05 derived calculation.
 *
 * A calculation result alone is never PASS. Missing baseline source stays
 * INDETERMINATE. This never grants guide review_ready.
 */
import type { EngineerCalculation, EngineerUnit } from '../../shared/src/engineer-case-contract.js';
import { compareValue } from './compare.js';
import type { Verdict } from './types.js';

export type SourcedCalculationBaseline = {
  readonly source: string;
  readonly sourceUrl?: string;
  readonly op: 'gte' | 'lte';
  readonly threshold: number;
  readonly unit: EngineerUnit;
};

export type DerivedFitnessResult = {
  readonly verdict: Verdict;
  readonly reason: string;
  readonly reasonCode:
    | 'CALCULATION_UNAVAILABLE'
    | 'BASELINE_SOURCE_MISSING'
    | 'BASELINE_THRESHOLD_INVALID'
    | 'UNIT_INCOMPATIBLE'
    | 'CONFIRMED_PASS'
    | 'CONFIRMED_FAIL'
    | 'VM_COUNT_NOT_CAPACITY_OR_HA';
  readonly guideReadyGranted: false;
};

function refuse(
  reasonCode: DerivedFitnessResult['reasonCode'],
  reason: string,
  verdict: Verdict = 'INDETERMINATE',
): DerivedFitnessResult {
  return { verdict, reason, reasonCode, guideReadyGranted: false };
}

export function evaluateDerivedFitness(input: {
  readonly calculation: EngineerCalculation;
  readonly baseline?: SourcedCalculationBaseline;
}): DerivedFitnessResult {
  const calculation = input.calculation;
  if (calculation.formulaId === 'ha-n-plus-one-capacity') {
    return refuse('VM_COUNT_NOT_CAPACITY_OR_HA', calculation.unavailableReason ?? 'VM or node count is not HA or capacity fitness');
  }
  if (calculation.sourceKind === 'unknown' || calculation.result?.presence !== 'known') {
    return refuse('CALCULATION_UNAVAILABLE', calculation.unavailableReason ?? 'calculation unavailable');
  }
  if (calculation.result.data.kind !== 'number' && calculation.result.data.kind !== 'integer') {
    return refuse('CALCULATION_UNAVAILABLE', 'NON_NUMERIC_RESULT');
  }
  const baseline = input.baseline;
  if (!baseline || !baseline.source.trim()) {
    return refuse('BASELINE_SOURCE_MISSING', '기준값 출처 없음 — 적합 PASS 불가');
  }
  if (!Number.isFinite(baseline.threshold)) {
    return refuse('BASELINE_THRESHOLD_INVALID', 'baseline threshold is not a finite number');
  }
  const resultUnit = calculation.result.data.kind === 'number'
    ? calculation.result.data.unit
    : calculation.result.data.unit;
  const observed = calculation.result.data.kind === 'number'
    ? calculation.result.data.number
    : calculation.result.data.integer;
  if (resultUnit !== baseline.unit) {
    return refuse('UNIT_INCOMPATIBLE', `result unit ${String(resultUnit)} does not match baseline unit ${baseline.unit}`);
  }
  const compared = compareValue(baseline.op, observed, baseline.threshold);
  if (compared === 'indeterminate') {
    return refuse('BASELINE_THRESHOLD_INVALID', 'baseline comparison is indeterminate');
  }
  if (compared === 'pass') {
    return {
      verdict: 'PASS',
      reason: `matches sourced baseline ${baseline.op} ${baseline.threshold} ${baseline.unit} (${baseline.source})`,
      reasonCode: 'CONFIRMED_PASS',
      guideReadyGranted: false,
    };
  }
  return {
    verdict: 'FAIL',
    reason: `does not match sourced baseline ${baseline.op} ${baseline.threshold} ${baseline.unit} (${baseline.source})`,
    reasonCode: 'CONFIRMED_FAIL',
    guideReadyGranted: false,
  };
}
