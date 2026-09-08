import { z } from 'zod';

const rate = z.number().finite().min(0).max(1);
const delta = z.number().finite().min(-1).max(1);
export const corpusQualityThresholdsSchema = z.object({
  candidateHitRateAt5Min: rate,
  candidateHitRateAt5VsBaselineMinDelta: delta,
  candidateRecallAt5VsBaselineMinDelta: delta,
  candidateMrrAt5VsBaselineMinDelta: delta,
  candidateNdcgAt5VsBaselineMinDelta: delta,
  candidateHardNegativeRateAt5Max: rate,
  candidateHardNegativeRateAt5VsBaselineMaxDelta: delta,
  candidateNoAnswerFalsePositiveRateAt5Max: rate,
  candidateNoAnswerFalsePositiveRateAt5VsBaselineMaxDelta: delta,
  candidateMeanLatencyVsBaselineMaxRatio: z.number().finite().positive(),
  candidateP95LatencyVsBaselineMaxRatio: z.number().finite().positive(),
}).strict();

const metrics = z.object({ queryCount: z.number().int().positive(), hitRateAtK: rate, recallAtK: rate, mrrAtK: rate, ndcgAtK: rate });
export const corpusReportSchema = z.object({
  schemaVersion: z.literal(2), k: z.literal(5), qrelsSha256: z.string().regex(/^[a-f0-9]{64}$/),
  settingsSha256: z.string().regex(/^[a-f0-9]{64}$/), metrics,
  noAnswerQueryCount: z.number().int().positive(), noAnswerFalsePositiveRate: rate,
  hardNegativeQueryRate: rate, forbiddenHits: z.number().int().nonnegative(),
  meanLatencyMs: z.number().finite().positive(), p95LatencyMs: z.number().finite().positive(),
});

/** Offline quality eligibility only. This never grants index or runtime promotion authority. */
export function compareCorpusQuality(candidateValue: unknown, baselineValue: unknown, thresholdsValue: unknown) {
  const c = corpusReportSchema.parse(candidateValue);
  const b = corpusReportSchema.parse(baselineValue);
  const t = corpusQualityThresholdsSchema.parse(thresholdsValue);
  if (c.qrelsSha256 !== b.qrelsSha256 || c.settingsSha256 !== b.settingsSha256 ||
      c.metrics.queryCount !== b.metrics.queryCount || c.noAnswerQueryCount !== b.noAnswerQueryCount) {
    throw new Error('RAG_EVAL_INCOMPARABLE_REPORTS');
  }
  const checks = {
    hitAbsolute: c.metrics.hitRateAtK >= t.candidateHitRateAt5Min,
    hitDelta: c.metrics.hitRateAtK - b.metrics.hitRateAtK >= t.candidateHitRateAt5VsBaselineMinDelta,
    recallDelta: c.metrics.recallAtK - b.metrics.recallAtK >= t.candidateRecallAt5VsBaselineMinDelta,
    mrrDelta: c.metrics.mrrAtK - b.metrics.mrrAtK >= t.candidateMrrAt5VsBaselineMinDelta,
    ndcgDelta: c.metrics.ndcgAtK - b.metrics.ndcgAtK >= t.candidateNdcgAt5VsBaselineMinDelta,
    hardNegativeAbsolute: c.hardNegativeQueryRate <= t.candidateHardNegativeRateAt5Max,
    hardNegativeDelta: c.hardNegativeQueryRate - b.hardNegativeQueryRate <= t.candidateHardNegativeRateAt5VsBaselineMaxDelta,
    noAnswerAbsolute: c.noAnswerFalsePositiveRate <= t.candidateNoAnswerFalsePositiveRateAt5Max,
    noAnswerDelta: c.noAnswerFalsePositiveRate - b.noAnswerFalsePositiveRate <= t.candidateNoAnswerFalsePositiveRateAt5VsBaselineMaxDelta,
    forbiddenSources: c.forbiddenHits === 0,
    meanLatency: c.meanLatencyMs / b.meanLatencyMs <= t.candidateMeanLatencyVsBaselineMaxRatio,
    p95Latency: c.p95LatencyMs / b.p95LatencyMs <= t.candidateP95LatencyVsBaselineMaxRatio,
  };
  return { decision: Object.values(checks).every(Boolean) ? 'QUALITY_ELIGIBLE' : 'NOT_ELIGIBLE',
    promotionAuthorized: false, checks,
    limitations: ['single-run latency is not an operational SLO', 'offline report is not authority evidence'] };
}
