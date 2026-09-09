/**
 * Verdict engine: compare a spec to an observed config.
 *
 * Safety principle (fixes the verifier false-pass class of bug):
 *   INDETERMINATE is NEVER counted as PASS, and overall `ok` requires positive
 *   evidence (at least one PASS, zero FAIL, zero INDETERMINATE).
 */

import { compareValue } from './compare.js';
import type {
  Category,
  CoverageInfo,
  EvaluateOptions,
  EvaluationResult,
  EvaluationSummary,
  IntendedSpec,
  ItemResult,
  ObservedFact,
  ObservedSource,
  SpecItem,
  Verdict,
} from './types.js';

/** A1 freshness SLO. Returns a demotion reason when the item declares maxAgeSec and
 *  the evidence cannot be proven fresh; null when the item has no budget or the
 *  evidence is within it. Only ever consulted on a would-be PASS — demotion-only. */
function freshnessDemotion(item: SpecItem, source: ObservedSource | undefined, nowMs: number, options: EvaluateOptions): string | null {
  const mode = options.mode ?? 'comparison';
  if (mode === 'snapshot' && options.now === undefined) return 'assessment-time-missing: 과거 스냅샷 평가 시각 필요';
  if (!Number.isFinite(nowMs)) return 'assessment-time-invalid: 평가 기준 시각 파싱 불가';
  if (source?.collectionStatus === 'partial' || source?.collectionStatus === 'failed') {
    return `collection-incomplete: ${source.collectionStatus} 수집으로 정상 판정 불가`;
  }
  if (mode === 'current' && source?.collectionStatus !== 'complete') return 'collection-unproven: 현재 상태의 수집 완전성 근거 없음';
  if (item.maxAgeSec === undefined && mode === 'current') return 'freshness-policy-missing: 항목별 관측 유효시간 정책 필요';
  if (item.maxAgeSec === undefined && mode === 'comparison') return null;
  if (item.maxAgeSec !== undefined && (!Number.isFinite(item.maxAgeSec) || item.maxAgeSec < 0)) return 'freshness-policy-invalid: 잘못된 관측 유효시간';
  const skew = options.maxFutureSkewSec ?? 0;
  if (!Number.isFinite(skew) || skew < 0) return 'freshness-policy-invalid: 잘못된 미래 시각 허용 범위';
  const collectedAt = source?.collectedAt;
  if (!collectedAt) {
    return 'evidence-expired: 신선도 입증 불가 — 관측값에 collectedAt 없음 (freshness unprovable)';
  }
  const capturedMs = Date.parse(collectedAt);
  if (Number.isNaN(capturedMs)) {
    return `evidence-expired: collectedAt 파싱 불가 (${collectedAt})`;
  }
  const ageSec = (nowMs - capturedMs) / 1000;
  if (ageSec < -skew) return 'evidence-future: 관측 시각이 평가 기준 시각보다 미래임';
  if (item.maxAgeSec !== undefined && ageSec > item.maxAgeSec) {
    return `evidence-expired: 증거 나이 ${Math.round(ageSec)}s > 허용 ${item.maxAgeSec}s`;
  }
  return null;
}

export function evaluateSpec(spec: IntendedSpec, observed: Record<string, unknown>, options?: EvaluateOptions): EvaluationResult {
  const nowMs = options?.now !== undefined ? new Date(options.now).getTime() : Date.now();
  const items: ItemResult[] = spec.items.map((item) => {
    const base = { id: item.id, label: item.label, expected: item.expected };

    // Cannot assert a MUST item without a source citation — needs senior review.
    if (item.severity === 'must' && !item.source) {
      return { ...base, verdict: 'INDETERMINATE', category: 'indeterminate',
        reason: 'MUST item has no source citation — needs senior review before asserting misconfiguration' };
    }

    // No observed value → cannot determine.
    if (!Object.prototype.hasOwnProperty.call(observed, item.observedKey)) {
      return { ...base, verdict: 'INDETERMINATE', category: 'indeterminate',
        reason: `No observed value for "${item.observedKey}"` };
    }

    const fact = normalizeFact(observed[item.observedKey]);
    const value = fact.value;
    const observedSource = fact.source;
    const withSrc = <T extends object>(r: T) => (observedSource ? { ...r, observedSource } : r);
    const cmp = compareValue(item.op, value, item.expected);
    if (cmp === 'indeterminate') {
      // Observed type/shape is incompatible with the expected type (e.g. scraped
      // string 'true' vs boolean true, 'N/A' vs a numeric threshold). Comparing
      // anyway would fabricate a PASS or FAIL — surface it as 판정 불가 instead.
      return withSrc({ ...base, verdict: 'INDETERMINATE' as Verdict, category: 'indeterminate' as Category, observed: value,
        reason: `관측 타입(${typeof value})이 기대 타입과 불일치하거나 수치 변환 불가 — 판정 불가` });
    }
    if (cmp === 'pass') {
      // A datum flagged for senior review must never be auto-PASSed, even on a match.
      if (item.needsSeniorReview) {
        return withSrc({ ...base, verdict: 'INDETERMINATE' as Verdict, category: 'indeterminate' as Category, observed: value,
          reason: '시니어 검토 필요 항목 — 자동 PASS 금지 (senior review required)' });
      }
      // A1: a match on expired/unprovable evidence must not become a PASS.
      const expired = freshnessDemotion(item, observedSource, nowMs, options ?? {});
      if (expired) {
        return withSrc({ ...base, verdict: 'INDETERMINATE' as Verdict, category: 'indeterminate' as Category, observed: value,
          reason: expired });
      }
      return withSrc({ ...base, verdict: 'PASS' as Verdict, category: 'ok' as Category, observed: value, reason: 'matches expected' });
    }
    // A deviating value that is environment-dependent is NOT a misconfiguration:
    // classify it separately so it never inflates the misconfig/missing counts.
    const category: Category = item.contextDependent
      ? 'context_dependent'
      : item.severity === 'must' ? 'misconfiguration' : 'missing';
    const seniorNote = item.needsSeniorReview ? ' — 시니어 검토 필요(senior review)' : '';
    return withSrc({ ...base, verdict: 'FAIL' as Verdict, category, observed: value,
      reason: `expected ${item.op} ${JSON.stringify(item.expected)}, observed ${JSON.stringify(value)}${seniorNote}` });
  });

  const summary = summarize(items);
  const observedKeys = Object.keys(observed);
  const specKeys = new Set(spec.items.map((i) => i.observedKey));
  const coverage: CoverageInfo = {
    specifiedTotal: spec.items.length,
    observedTotal: observedKeys.length,
    unspecifiedKeys: observedKeys.filter((k) => !specKeys.has(k)),
    unobservedItems: spec.items.filter((i) => !Object.prototype.hasOwnProperty.call(observed, i.observedKey)).map((i) => i.id),
  };
  return { specId: spec.id, ok: computeOk(summary), items, summary, coverage,
    assessment: {
      mode: options?.mode ?? 'comparison',
      evaluatedAt: Number.isFinite(nowMs) ? new Date(nowMs).toISOString() : null,
      freshnessRequired: options?.mode === 'current' || spec.items.some((item) => item.maxAgeSec !== undefined),
    },
  };
}

/** Detect the ObservedFact provenance wrapper ({ value, source }) vs a bare observed
 *  value. Requires BOTH keys so a legitimate object config that merely has a `value`
 *  field is never silently unwrapped (which would swap the comparison target). */
function isObservedFact(v: unknown): v is ObservedFact {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const has = (k: string) => Object.prototype.hasOwnProperty.call(v, k);
  if (!has('value') || !has('source')) return false;
  return Object.keys(v as object).every((k) => k === 'value' || k === 'source');
}

function normalizeFact(raw: unknown): ObservedFact {
  return isObservedFact(raw) ? { value: raw.value, source: raw.source } : { value: raw };
}

function summarize(items: ItemResult[]): EvaluationSummary {
  return {
    pass: items.filter((i) => i.verdict === 'PASS').length,
    fail: items.filter((i) => i.verdict === 'FAIL').length,
    indeterminate: items.filter((i) => i.verdict === 'INDETERMINATE').length,
    misconfiguration: items.filter((i) => i.category === 'misconfiguration').length,
    missing: items.filter((i) => i.category === 'missing').length,
    contextDependent: items.filter((i) => i.category === 'context_dependent').length,
  };
}

function computeOk(s: EvaluationSummary): boolean {
  // positive evidence required; no failures; nothing undetermined
  return s.pass > 0 && s.fail === 0 && s.indeterminate === 0;
}
