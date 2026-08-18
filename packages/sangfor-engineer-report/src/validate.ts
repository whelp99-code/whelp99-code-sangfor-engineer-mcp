/**
 * Anti-overrule gate (design 002, principle 2.1).
 *
 * The one rule this package exists to enforce: an EngineerReport may only carry
 * the verdicts the deterministic engine produced. `validateEngineerReport`
 * compares the report's `engineResult` against the reference `evaluateSpec`
 * output structurally — verdicts, categories, observed values, summary counters
 * and coverage all included — and refuses any difference. Agent prose
 * (riskNote, recommendations, rollbackPlan) is annotation and is never
 * inspected here: it cannot make a report pass or fail this gate.
 */
import type { EvaluationResult } from '@sangfor/spec';
import { canonicalEquals, canonicalJson } from './canonical.js';
import type { EngineerReport } from './report.js';

export interface ValidateEngineerReportResult {
  ok: boolean;
  reason?: string;
  /** Spec item ids whose engine result differs (or is missing/invented). Sorted. */
  mismatchedItemIds?: string[];
}

function mismatchedItemIds(
  reported: EvaluationResult['items'],
  reference: EvaluationResult['items'],
): string[] {
  const reportedById = new Map(reported.map((item) => [item.id, item]));
  const referenceById = new Map(reference.map((item) => [item.id, item]));
  const ids = new Set<string>([...reportedById.keys(), ...referenceById.keys()]);
  const mismatched: string[] = [];
  for (const id of ids) {
    const a = reportedById.get(id);
    const b = referenceById.get(id);
    if (a === undefined || b === undefined || !canonicalEquals(a, b)) mismatched.push(id);
  }
  return mismatched.sort();
}

/**
 * Refuse `report` unless its engineResult deep-equals `reference` — the engine
 * output the agent was given. Returns the offending item ids so the caller can
 * name exactly which verdict someone tried to overrule.
 */
export function validateEngineerReport(
  report: EngineerReport,
  reference: EvaluationResult,
): ValidateEngineerReportResult {
  const reported = report.engineResult as unknown as EvaluationResult;
  if (canonicalEquals(reported, reference)) return { ok: true };

  const mismatched = mismatchedItemIds(reported.items ?? [], reference.items ?? []);
  const detail = mismatched.length > 0
    ? `items [${mismatched.join(', ')}]`
    : `summary/coverage (${canonicalJson(reported.summary)} vs ${canonicalJson(reference.summary)})`;
  return {
    ok: false,
    reason: `engineResult was altered vs the engine output — ${detail}. The LLM never influences verdicts.`,
    mismatchedItemIds: mismatched,
  };
}
