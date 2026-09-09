import { afterEach, describe, expect, it, vi } from 'vitest';
import { localScoreOrderFromEnv, orderScoredHits } from '../packages/sangfor-rag/src/local-score-order.js';
afterEach(() => vi.unstubAllEnvs());
describe('separate score filtering and source ordering', () => {
  it('recovers a strong retrieval candidate pushed below top 5 by model-only ordering', () => {
    const candidates = Array.from({ length: 8 }, (_, i) => ({ id: `${i}`, score: 1 - i / 10 }));
    const scored = [7.8, 9, 8.8, 8.6, 8.4, 8.2, 8, 7.6].map((score, i) => ({ id: `${i}`, score }));
    expect(orderScoredHits(candidates, scored, 4, 'model').slice(0, 5).map(h => h.id)).not.toContain('0');
    expect(orderScoredHits(candidates, scored, 4, 'rrf').slice(0, 5).map(h => h.id)).toContain('0');
    expect(orderScoredHits(candidates, scored, 4, 'retrieval')[0]).toEqual({ id: '0', score: 1, rerankScore: 7.8 });
  });
  it.each(['model', 'retrieval', 'rrf'] as const)('never changes accepted membership or source scores under %s ordering', mode => {
    const candidates = Object.freeze([{ id: 'a', score: 1 }, { id: 'b', score: .9 }, { id: 'c', score: .8 }].map(item => Object.freeze(item)));
    const scored = Object.freeze([{ id: 'a', score: 4 }, { id: 'b', score: 3.9 }, { id: 'c', score: 8 }].map(item => Object.freeze(item)));
    const result = orderScoredHits(candidates, scored, 4, mode);
    expect(result.map(h => h.id).sort()).toEqual(['a', 'c']);
    expect(result.find(h => h.id === 'a')).toEqual({ id: 'a', score: 1, rerankScore: 4 });
    expect(candidates[0]).toEqual({ id: 'a', score: 1 });
    expect(scored[0]).toEqual({ id: 'a', score: 4 });
  });
  it.each([
    { rows: [{ id: 'a', score: 4 }] },
    { rows: [{ id: 'a', score: 4 }, { id: 'a', score: 5 }] },
    { rows: [{ id: 'a', score: 4 }, { id: 'unknown', score: -1 }] },
    { rows: [{ id: 'a', score: 4 }, { id: 'b', score: NaN }] },
  ])('rejects incomplete or untrusted score identities before ordering %j', ({ rows }) => {
    expect(() => orderScoredHits([{ id: 'a', score: 1 }, { id: 'b', score: .5 }], rows, 4, 'rrf'))
      .toThrow('RAG_SCORE_GATE_INCOMPLETE_RESPONSE');
  });
  it('refuses duplicate candidate identities', () => {
    expect(() => orderScoredHits([{ id: 'a', score: 1 }, { id: 'a', score: .5 }], [{ id: 'a', score: 4 }, { id: 'b', score: 5 }], 4, 'rrf'))
      .toThrow('RAG_SCORE_GATE_INCOMPLETE_RESPONSE');
  });
  it('rejects unknown configured ordering', () => {
    vi.stubEnv('SANGFOR_LOCAL_RERANK_SCORE_ORDER', 'invalid');
    expect(localScoreOrderFromEnv).toThrow('RAG_SCORE_GATE_ORDER_INVALID');
  });
});
