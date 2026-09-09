/**
 * Deterministic current-vs-desired compare for engineer-case assessments (E06).
 *
 * INDETERMINATE is never satisfied/PASS. Document search is not device state.
 * This never grants guide review_ready.
 */
import type {
  EngineerAssessmentStatus,
  EngineerUnit,
  EngineerValue,
} from '../../shared/src/engineer-case-contract.js';
import { compareValue, type CompareOutcome } from './compare.js';
import type { CompareOp, Verdict } from './types.js';

export type EngineerParsedConstraint =
  | { readonly kind: 'numeric'; readonly op: Extract<CompareOp, 'gte' | 'lte' | 'eq'>; readonly threshold: number; readonly unit: EngineerUnit }
  | { readonly kind: 'boolean'; readonly expected: boolean }
  | { readonly kind: 'not_applicable_text' }
  | { readonly kind: 'unparseable'; readonly reason: string };

export type EngineerRequirementCompareInput = {
  readonly current?: EngineerValue;
  readonly desired?: EngineerParsedConstraint;
  readonly freshnessIssue?: string;
  readonly searchOnly?: boolean;
  readonly conflicting?: boolean;
};

export type EngineerRequirementCompareResult = {
  readonly verdict: Verdict;
  readonly status: EngineerAssessmentStatus;
  readonly reason: string;
  readonly reasonCode:
    | 'CONFIRMED_MATCH'
    | 'CONFIRMED_GAP'
    | 'INDETERMINATE_NOT_PASS'
    | 'DOCUMENT_SEARCH_NOT_DEVICE_STATE'
    | 'CONFLICTING_OBSERVATION'
    | 'STALE_OR_INCOMPLETE'
    | 'MISSING_CURRENT'
    | 'UNPARSEABLE_CONSTRAINT';
  readonly guideReadyGranted: false;
};

const NUMERIC_RE = /(?:^|[^\w.])(>=|<=|==|=|>|<)\s*([+-]?\d+(?:\.\d+)?)\s*(GiB|TiB|MiB|KiB|GB|TB|MB|KB|percent|%|cores|vcpu|nodes|VMs)(?!\w)/iu;
const NA_RE = /^(n\/a|n\.a\.|not[_ ]applicable|해당\s*없음)\b/iu;
const BOOL_RE = /\b(enabled|disabled|true|false)\b/iu;

function refuse(
  reasonCode: EngineerRequirementCompareResult['reasonCode'],
  reason: string,
): EngineerRequirementCompareResult {
  return {
    verdict: 'INDETERMINATE',
    status: 'unresolved',
    reason,
    reasonCode,
    guideReadyGranted: false,
  };
}

export function parseEngineerConstraint(text: string | undefined): EngineerParsedConstraint {
  const raw = text?.trim() ?? '';
  if (!raw) return { kind: 'unparseable', reason: 'MISSING_CONSTRAINT' };
  if (NA_RE.test(raw)) return { kind: 'not_applicable_text' };
  if (/\b(?:\d+(?:\.\d+)?)\s*(?:G|기가)\b/u.test(raw) && !NUMERIC_RE.test(raw)) {
    return { kind: 'unparseable', reason: 'AMBIGUOUS_UNIT' };
  }
  const numeric = NUMERIC_RE.exec(raw);
  if (numeric) {
    const opRaw = numeric[1] ?? '';
    const threshold = Number(numeric[2]);
    const unitRaw = numeric[3] ?? '';
    if (!Number.isFinite(threshold)) return { kind: 'unparseable', reason: 'INVALID_NUMBER' };
    if (opRaw === '>' || opRaw === '<') {
      return { kind: 'unparseable', reason: 'EXCLUSIVE_COMPARE_UNSUPPORTED' };
    }
    const op: Extract<CompareOp, 'gte' | 'lte' | 'eq'> = opRaw === '>=' ? 'gte' : opRaw === '<=' ? 'lte' : 'eq';
    const unit: EngineerUnit = unitRaw === '%' ? 'percent' : unitRaw as EngineerUnit;
    return { kind: 'numeric', op, threshold, unit };
  }
  const bool = BOOL_RE.exec(raw);
  if (bool) {
    const token = (bool[1] ?? '').toLowerCase();
    return { kind: 'boolean', expected: token === 'enabled' || token === 'true' };
  }
  return { kind: 'unparseable', reason: 'UNPARSEABLE_CONSTRAINT' };
}

export function knownEngineerScalar(value: EngineerValue): { ok: true; value: unknown; unit?: EngineerUnit } | { ok: false; reason: string } {
  if (value.presence !== 'known') return { ok: false, reason: value.reason };
  const data = value.data;
  if (data.kind === 'number') return { ok: true, value: data.number, unit: data.unit };
  if (data.kind === 'integer') return { ok: true, value: data.integer, unit: data.unit };
  if (data.kind === 'boolean') return { ok: true, value: data.boolean };
  return { ok: true, value: data.text };
}

export function compareEngineerOutcome(op: CompareOp, observed: unknown, expected: unknown): CompareOutcome {
  return compareValue(op, observed, expected);
}

/**
 * Map a three-state compare onto engineer assessment status.
 * INDETERMINATE is unresolved and never satisfied.
 */
export function evaluateEngineerRequirementCompare(
  input: EngineerRequirementCompareInput,
): EngineerRequirementCompareResult {
  if (input.searchOnly) {
    return refuse('DOCUMENT_SEARCH_NOT_DEVICE_STATE', '문서 검색 근거만으로는 현재 고객 장비 상태 PASS를 부여할 수 없음');
  }
  if (input.conflicting) {
    return refuse('CONFLICTING_OBSERVATION', '충돌하는 관측값은 자동으로 덮어쓰지 않음');
  }
  if (input.freshnessIssue) {
    return refuse('STALE_OR_INCOMPLETE', input.freshnessIssue);
  }
  if (!input.current || input.current.presence !== 'known') {
    return refuse('MISSING_CURRENT', input.current?.presence === 'unknown' ? input.current.reason : 'MISSING_CURRENT');
  }
  const desired = input.desired;
  if (!desired || desired.kind === 'unparseable') {
    return refuse('UNPARSEABLE_CONSTRAINT', desired?.kind === 'unparseable' ? desired.reason : 'MISSING_CONSTRAINT');
  }
  if (desired.kind === 'not_applicable_text') {
    return refuse('UNPARSEABLE_CONSTRAINT', 'NOT_APPLICABLE_TEXT_IS_NOT_A_STATUS');
  }

  const current = knownEngineerScalar(input.current);
  if (!current.ok) return refuse('MISSING_CURRENT', current.reason);

  if (desired.kind === 'boolean') {
    const outcome = compareEngineerOutcome('eq', current.value, desired.expected);
    return outcomeToResult(outcome, `boolean ${String(desired.expected)}`);
  }

  if (current.unit && current.unit !== desired.unit && !(current.unit === 'percent' && desired.unit === '%') && !(current.unit === '%' && desired.unit === 'percent')) {
    return refuse('INDETERMINATE_NOT_PASS', `UNIT_INCOMPATIBLE:${current.unit}:${desired.unit}`);
  }
  const outcome = compareEngineerOutcome(desired.op, current.value, desired.threshold);
  return outcomeToResult(outcome, `${desired.op} ${desired.threshold} ${desired.unit}`);
}

function outcomeToResult(outcome: CompareOutcome, expected: string): EngineerRequirementCompareResult {
  if (outcome === 'indeterminate') {
    return refuse('INDETERMINATE_NOT_PASS', `비교 불가 — INDETERMINATE는 PASS가 아님 (${expected})`);
  }
  if (outcome === 'pass') {
    return {
      verdict: 'PASS',
      status: 'satisfied',
      reason: `matches desired ${expected}`,
      reasonCode: 'CONFIRMED_MATCH',
      guideReadyGranted: false,
    };
  }
  return {
    verdict: 'FAIL',
    status: 'change_needed',
    reason: `does not match desired ${expected}`,
    reasonCode: 'CONFIRMED_GAP',
    guideReadyGranted: false,
  };
}
