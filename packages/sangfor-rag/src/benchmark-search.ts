import { computeBm25Scores } from './bm25.js';
import { cosineSimilarity, hashEmbedding } from './hash-embedding.js';
import { minMaxNormalizer } from './index.js';
import { normalizeRetrievalQuery } from './query-normalization.js';
import type { BenchmarkChunk, BenchmarkQuery } from './benchmark-schema.js';

export type VectorizedChunk = BenchmarkChunk & { readonly vector: readonly number[] };
export type BenchmarkHit = {
  readonly id: string;
  readonly score: number;
  readonly cosineScore: number;
  readonly keywordScore: number;
};
export type QueryAudit = {
  readonly id: string;
  readonly candidateIds: readonly string[];
  readonly hitIds: readonly string[];
  readonly expectedIds: readonly string[];
  readonly forbiddenIds: readonly string[];
};

export function buildVectors(chunks: readonly BenchmarkChunk[], dimensions: number): readonly VectorizedChunk[] {
  return chunks.map((chunk) => ({ ...chunk, vector: hashEmbedding(chunk.text, dimensions) }));
}

export function filterBenchmarkCandidates(
  chunks: readonly VectorizedChunk[],
  query: BenchmarkQuery
): readonly VectorizedChunk[] {
  return chunks.filter((chunk) =>
    chunk.tenantId === query.scope.tenantId
    && chunk.projectId === query.scope.projectId
    && (chunk.aclActorIds.length === 0 || chunk.aclActorIds.includes(query.scope.actorId))
    && (!query.filters.product || chunk.product === query.filters.product)
    && (!query.filters.version || chunk.version === query.filters.version)
    && (!query.filters.sourceType || chunk.sourceType === query.filters.sourceType)
    && (!query.filters.trustLevel || chunk.trustLevel === query.filters.trustLevel)
  );
}

export function rankExactCandidates(
  candidates: readonly VectorizedChunk[],
  query: BenchmarkQuery,
  dimensions: number
): readonly BenchmarkHit[] {
  const normalizedQuery = normalizeRetrievalQuery(query.text);
  const queryVector = hashEmbedding(normalizedQuery, dimensions);
  const cosineScores = candidates.map((chunk) => cosineSimilarity(queryVector, [...chunk.vector]));
  const bm25 = computeBm25Scores(normalizedQuery, candidates.map((chunk) => ({ id: chunk.id, text: `${chunk.title}\n${chunk.text}` })));
  const keywordScores = candidates.map((chunk) => bm25.get(chunk.id) ?? 0);
  const cosineNormalizer = minMaxNormalizer(cosineScores);
  const keywordNormalizer = minMaxNormalizer(keywordScores);
  return candidates.map((chunk, index): BenchmarkHit => ({
    id: chunk.id,
    cosineScore: cosineScores[index] ?? 0,
    keywordScore: keywordScores[index] ?? 0,
    score: 0.5 * cosineNormalizer(cosineScores[index] ?? 0) + 0.5 * keywordNormalizer(keywordScores[index] ?? 0)
  })).sort((left, right) => right.score - left.score || left.id.localeCompare(right.id)).slice(0, query.limit);
}
