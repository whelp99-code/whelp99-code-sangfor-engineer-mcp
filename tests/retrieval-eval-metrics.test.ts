import { describe, expect, it } from 'vitest';
import { computeRetrievalMetrics } from '../packages/sangfor-rag/src/retrieval-eval.js';

describe('computeRetrievalMetrics', () => {
  it('computes source-deduplicated rank metrics from stable qrels and runs', () => {
    const metrics = computeRetrievalMetrics(
      [
        { queryId: 'q1', sourceId: 'doc-a', grade: 3 },
        { queryId: 'q1', sourceId: 'doc-b', grade: 1 },
        { queryId: 'q2', sourceId: 'doc-c', grade: 2 }
      ],
      [
        { queryId: 'q1', sourceId: 'doc-x', rank: 1, score: 0.9 },
        { queryId: 'q1', sourceId: 'doc-a', rank: 2, score: 0.8 },
        { queryId: 'q1', sourceId: 'doc-a', rank: 3, score: 0.7 },
        { queryId: 'q2', sourceId: 'doc-y', rank: 1, score: 0.9 }
      ],
      3
    );

    expect(metrics.queryCount).toBe(2);
    expect(metrics.hitRateAtK).toBe(0.5);
    expect(metrics.recallAtK).toBe(0.25);
    expect(metrics.mrrAtK).toBe(0.25);
    expect(metrics.ndcgAtK).toBeGreaterThan(0);
    expect(metrics.ndcgAtK).toBeLessThan(0.5);
  });
});
