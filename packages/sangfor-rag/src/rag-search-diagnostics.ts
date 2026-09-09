import type { EmbeddingBackend } from './embedding-provider-types.js';
import { canCompareVector } from './rag-ranking.js';
import { embeddingSpaceId, type EmbeddingSpace } from './embedding-space.js';
import type { RagIndex, RagSearchDiagnostics, RagSearchHit } from './rag-types.js';

let lastRagSearchDiagnostics: RagSearchDiagnostics = { degraded: false };
const resultDiagnostics = new WeakMap<readonly RagSearchHit[], RagSearchDiagnostics>();

export function getRagSearchDiagnostics(hits?: readonly RagSearchHit[]): RagSearchDiagnostics {
  return hits ? resultDiagnostics.get(hits) ?? { degraded: true, degradedReason: 'diagnostics unavailable for this result' } : lastRagSearchDiagnostics;
}

export function withDiagnostics(hits: RagSearchHit[], diagnostics: RagSearchDiagnostics): RagSearchHit[] {
  const actual = { ...diagnostics, retrievalMode: hits.some((hit) => hit.retrievalMode === 'hybrid-semantic')
    ? 'hybrid-semantic' as const : hits.some((hit) => hit.retrievalMode === 'hybrid-hash') ? 'hybrid-hash' as const : 'bm25' as const };
  resultDiagnostics.set(hits, actual);
  lastRagSearchDiagnostics = actual;
  return hits;
}

export function countBy<T extends string | number>(items: readonly T[]): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    const key = String(item);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

export function computeRagSearchDiagnostics(
  index: RagIndex,
  queryWasHashFallback: boolean,
  queryBackend?: EmbeddingBackend,
  queryVectorDims?: number,
  querySpace?: EmbeddingSpace,
  queryVector: number[] = [],
): RagSearchDiagnostics {
  const reasons: string[] = [];
  const semanticChunks = index.chunks.filter((chunk) => (chunk.embeddingBackend ?? 'hash') !== 'hash').length;
  const indexVectorDims = countBy(index.chunks.map((chunk) => chunk.vectorDims ?? chunk.vector.length));
  const embeddingModelCounts = countBy(index.chunks.map(
    (chunk) => chunk.embeddingModel ?? `${chunk.embeddingBackend ?? 'hash'}:unknown`,
  ));
  const vectorDimensionMismatches = typeof queryVectorDims === 'number'
    ? index.chunks.filter((chunk) => chunk.vector.length !== queryVectorDims).length
    : 0;
  const mixedEmbeddingModels = Object.keys(embeddingModelCounts).length > 1;
  const incompatibleEmbeddingSpaces = index.chunks.filter((chunk) => !canCompareVector(chunk, queryVector, querySpace)).length;
  if (incompatibleEmbeddingSpaces > 0) reasons.push(`${incompatibleEmbeddingSpaces} chunks have no matching verified embedding space; their vector scores are disabled`);
  if (!querySpace) reasons.push('query embedding space is unavailable or unpinned; using BM25');
  if (index.chunks.length > 0 && semanticChunks === 0) {
    reasons.push('RAG index is hash-only (no semantic embeddings ingested) — ranking is lexical/hashed, not semantic');
  }
  if (queryWasHashFallback) {
    reasons.push('query embedding fell back to the hash backend (configured semantic provider unavailable)');
  }
  if (vectorDimensionMismatches > 0) {
    reasons.push(`${vectorDimensionMismatches} indexed chunks have vector dimensions that do not match the query vector`);
  }
  if (mixedEmbeddingModels) {
    reasons.push('RAG index contains mixed embedding model cohorts; semantic scores may be incomparable');
  }
  const diagnostics = {
    degraded: reasons.length > 0,
    queryBackend,
    queryVectorDims,
    indexVectorDims,
    embeddingModelCounts,
    vectorDimensionMismatches,
    mixedEmbeddingModels,
    incompatibleEmbeddingSpaces,
    queryEmbeddingSpaceId: querySpace ? embeddingSpaceId(querySpace) : undefined,
    retrievalMode: querySpace && incompatibleEmbeddingSpaces < index.chunks.length
      ? querySpace.model === 'hash' ? 'hybrid-hash' as const : 'hybrid-semantic' as const : 'bm25' as const,
  };
  return reasons.length > 0 ? { ...diagnostics, degradedReason: reasons.join('; ') } : diagnostics;
}

