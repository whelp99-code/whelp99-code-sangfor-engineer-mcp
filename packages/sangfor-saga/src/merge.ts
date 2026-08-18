/**
 * PM saga coordinator — merge half (design 002, block F3).
 *
 * Structural fields (engine summaries, ids) merge deterministically. Prose does
 * NOT: when two reports on the same finding recommend different things, the
 * merger emits an escalation citing both report ids instead of arbitrating.
 * An LLM-free reducer has no basis to prefer one engineer's wording over
 * another's, and picking silently is exactly how a wrong recommendation gets
 * laundered into "the merged answer".
 */
import type { EvaluationSummary } from '@sangfor/spec';
import type { EngineerReport } from '@sangfor/engineer-report';

export type EscalationReason =
  | 'conflicting-recommendations'
  | 'conflicting-rollback-plans'
  | 'conflicting-engine-verdicts';

export interface MergeEscalation {
  reason: EscalationReason;
  findingId: string;
  /** Report ids on both sides of the disagreement, sorted. */
  cited: string[];
}

export interface ReportForFinding {
  findingId: string;
  report: EngineerReport;
}

export interface MergedReports {
  summary: EvaluationSummary;
  reportIds: string[];
  deviceIds: string[];
  findingIds: string[];
  escalations: MergeEscalation[];
}

const EMPTY_SUMMARY: EvaluationSummary = {
  pass: 0, fail: 0, indeterminate: 0, misconfiguration: 0, missing: 0, contextDependent: 0,
};

function addSummary(acc: EvaluationSummary, next: EvaluationSummary): EvaluationSummary {
  return {
    pass: acc.pass + next.pass,
    fail: acc.fail + next.fail,
    indeterminate: acc.indeterminate + next.indeterminate,
    misconfiguration: acc.misconfiguration + next.misconfiguration,
    missing: acc.missing + next.missing,
    contextDependent: acc.contextDependent + next.contextDependent,
  };
}

/** Set-equality over prose lines: reordering is not disagreement, different content is. */
function sameProse(a: readonly string[], b: readonly string[]): boolean {
  const norm = (lines: readonly string[]) => JSON.stringify([...new Set(lines)].sort());
  return norm(a) === norm(b);
}

/** Verdict fingerprint of an engine result — the part two reports must agree on. */
function verdictFingerprint(report: EngineerReport): string {
  return JSON.stringify(
    [...report.engineResult.items]
      .map((item) => [item.id, item.verdict] as const)
      .sort((x, y) => x[0].localeCompare(y[0])),
  );
}

function escalationsForFinding(findingId: string, group: readonly EngineerReport[]): MergeEscalation[] {
  const out: MergeEscalation[] = [];
  const sorted = [...group].sort((a, b) => a.reportId.localeCompare(b.reportId));
  const checks: Array<{ reason: EscalationReason; agrees: (a: EngineerReport, b: EngineerReport) => boolean }> = [
    { reason: 'conflicting-recommendations', agrees: (a, b) => sameProse(a.recommendations, b.recommendations) },
    { reason: 'conflicting-rollback-plans', agrees: (a, b) => sameProse(a.rollbackPlan, b.rollbackPlan) },
    { reason: 'conflicting-engine-verdicts', agrees: (a, b) => verdictFingerprint(a) === verdictFingerprint(b) },
  ];

  for (const check of checks) {
    const cited = new Set<string>();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        if (check.agrees(sorted[i], sorted[j])) continue;
        cited.add(sorted[i].reportId);
        cited.add(sorted[j].reportId);
      }
    }
    if (cited.size > 0) {
      out.push({ reason: check.reason, findingId, cited: [...cited].sort() });
    }
  }
  return out;
}

/**
 * Reduce per-finding engineer reports into one structural view plus the
 * disagreements a human has to settle. Input order never affects the result and
 * the input reports are never mutated.
 */
export function mergeReports(reports: readonly ReportForFinding[]): MergedReports {
  const byFinding = new Map<string, EngineerReport[]>();
  for (const entry of reports) {
    const group = byFinding.get(entry.findingId) ?? [];
    group.push(entry.report);
    byFinding.set(entry.findingId, group);
  }

  let summary = EMPTY_SUMMARY;
  for (const entry of reports) summary = addSummary(summary, entry.report.engineResult.summary);

  const findingIds = [...byFinding.keys()].sort();
  const escalations: MergeEscalation[] = [];
  for (const findingId of findingIds) {
    escalations.push(...escalationsForFinding(findingId, byFinding.get(findingId) ?? []));
  }

  return {
    summary,
    reportIds: [...new Set(reports.map((r) => r.report.reportId))].sort(),
    deviceIds: [...new Set(reports.map((r) => r.report.deviceId))].sort(),
    findingIds,
    escalations,
  };
}
