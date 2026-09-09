export type LocalScoreOrder = 'model' | 'retrieval' | 'rrf';

export function localScoreOrderFromEnv(): LocalScoreOrder {
  const value = process.env.SANGFOR_LOCAL_RERANK_SCORE_ORDER ?? 'model';
  if (value !== 'model' && value !== 'retrieval' && value !== 'rrf') throw new Error('RAG_SCORE_GATE_ORDER_INVALID');
  return value;
}

/** Filtering never refills rejected passages; ordering is a separate policy. */
export function orderScoredHits<T extends { id: string; score: number }>(
  candidates: readonly T[], scored: ReadonlyArray<{ id: string; score: number }>,
  minimumScore: number, mode: LocalScoreOrder,
): Array<T & { rerankScore: number }> {
  const byId = new Map(candidates.map(hit => [hit.id, hit]));
  const inputOrder = new Map(candidates.map((hit, i) => [hit.id, i]));
  if (!Number.isFinite(minimumScore) || byId.size !== candidates.length || candidates.some(hit => !Number.isFinite(hit.score))
    || scored.length !== candidates.length || new Set(scored.map(row => row.id)).size !== scored.length
    || scored.some(row => !byId.has(row.id) || !Number.isFinite(row.score))) throw new Error('RAG_SCORE_GATE_INCOMPLETE_RESPONSE');
  const modelOrder = [...scored].sort((a, b) => b.score - a.score || inputOrder.get(a.id)! - inputOrder.get(b.id)!);
  const accepted = modelOrder.filter(row => row.score >= minimumScore)
    .map(row => ({ ...byId.get(row.id)!, rerankScore: row.score }));
  if (mode === 'model') return accepted;
  const retrievalRank = new Map([...candidates].sort((a, b) => b.score - a.score || inputOrder.get(a.id)! - inputOrder.get(b.id)!)
    .map((hit, i) => [hit.id, i + 1]));
  if (mode === 'retrieval') return accepted.sort((a, b) => retrievalRank.get(a.id)! - retrievalRank.get(b.id)!);
  if (mode !== 'rrf') throw new Error('RAG_SCORE_GATE_ORDER_INVALID');
  const modelRank = new Map(modelOrder.map((row, i) => [row.id, i + 1]));
  const fused = (id: string) => 1 / (60 + retrievalRank.get(id)!) + 1 / (60 + modelRank.get(id)!);
  return accepted.sort((a, b) => fused(b.id) - fused(a.id) || retrievalRank.get(a.id)! - retrievalRank.get(b.id)!);
}
