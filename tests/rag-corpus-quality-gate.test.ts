import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { compareCorpusQuality } from '../packages/sangfor-rag/src/corpus-eval-gate.js';
const thresholds = JSON.parse(readFileSync('data/evals/rag/revision-v1-qrels-v2.json', 'utf8')).thresholds;
const report = {
  schemaVersion: 2, k: 5, qrelsSha256: 'a'.repeat(64), settingsSha256: 'b'.repeat(64),
  metrics: { queryCount: 21, hitRateAtK: 0.9, recallAtK: 0.9, mrrAtK: 0.9, ndcgAtK: 0.9 },
  noAnswerQueryCount: 4, noAnswerFalsePositiveRate: 0, hardNegativeQueryRate: 0,
  forbiddenHits: 0, meanLatencyMs: 100, p95LatencyMs: 120,
};
describe('offline corpus quality gate', () => {
  it('grants no promotion authority even when all quality checks pass', () => {
    expect(compareCorpusQuality(report, report, thresholds)).toMatchObject({ decision: 'QUALITY_ELIGIBLE', promotionAuthorized: false });
  });
  it.each([
    { ...report, metrics: { ...report.metrics, hitRateAtK: 0.71 } },
    { ...report, forbiddenHits: 1 },
    { ...report, meanLatencyMs: 150 },
    { ...report, noAnswerFalsePositiveRate: 0.25 },
  ])('refuses a candidate failing any frozen criterion', (candidate) => {
    expect(compareCorpusQuality(candidate, report, thresholds).decision).toBe('NOT_ELIGIBLE');
  });
  it.each([
    { ...report, qrelsSha256: 'c'.repeat(64) },
    { ...report, settingsSha256: 'c'.repeat(64) },
    { ...report, noAnswerQueryCount: 0 },
    { ...report, k: 10 },
    { ...report, metrics: { ...report.metrics, hitRateAtK: NaN } },
  ])('rejects incomparable or unmeasured evidence', (candidate) => {
    expect(() => compareCorpusQuality(candidate, report, thresholds)).toThrow();
  });
  it('does not substitute default thresholds', () => {
    expect(() => compareCorpusQuality(report, report, {})).toThrow();
  });
});
