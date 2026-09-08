import { computeBm25Scores } from './bm25.js';
import { cosineSimilarity } from './hash-embedding.js';
import { sameEmbeddingSpace, type EmbeddingSpace } from './embedding-space.js';
import type { RagDocumentChunk } from './rag-types.js';

export function canCompareVector(chunk: RagDocumentChunk, queryVector: number[], querySpace?: EmbeddingSpace): boolean {
  return sameEmbeddingSpace(chunk.embeddingSpace, querySpace)
    && chunk.embeddingModel === querySpace?.model
    && chunk.vectorDims === querySpace?.dimensions
    && chunk.vector.length === queryVector.length && queryVector.length === querySpace?.dimensions
    && (chunk.embeddingBackend === 'hash') === (querySpace?.model === 'hash')
    && queryVector.every(Number.isFinite) && chunk.vector.every(Number.isFinite)
    && queryVector.some((value) => value !== 0) && chunk.vector.some((value) => value !== 0);
}

function resolveHybridAlpha(): number {
  const raw = process.env.SANGFOR_RAG_HYBRID_ALPHA;
  if (raw === undefined || raw.trim() === '') return 0.5;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return 0.5;
  return parsed;
}

export function minMaxNormalizer(values: readonly number[]): (value: number) => number {
  if (values.length === 0) return () => 0;
  let min = values[0];
  let max = values[0];
  for (let index = 1; index < values.length; index += 1) {
    const value = values[index];
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const range = max - min;
  if (range <= 1e-12) return () => 0;
  return (value: number) => (value - min) / range;
}

export function rankHybrid<T extends RagDocumentChunk>(
  candidates: readonly T[],
  queryVector: number[],
  query: string,
  querySpace?: EmbeddingSpace,
): Array<T & { readonly score: number; readonly cosineScore: number; readonly keywordScore: number;
  readonly vectorScoreUsed: boolean; readonly retrievalMode: 'hybrid-semantic' | 'hybrid-hash' | 'bm25' }> {
  const compatible = candidates.map((chunk) => canCompareVector(chunk, queryVector, querySpace));
  const alpha = compatible.some(Boolean) ? resolveHybridAlpha() : 0;
  const cosineScores = candidates.map((chunk, index) => compatible[index] ? cosineSimilarity(queryVector, chunk.vector) : 0);
  const bm25Scores = computeBm25Scores(query, candidates.map((chunk) => ({
    id: chunk.id,
    text: `${chunk.title}\n${chunk.text}`,
  })));
  const keywordScores = candidates.map((chunk) => bm25Scores.get(chunk.id) ?? 0);
  const normalizeCosine = minMaxNormalizer(cosineScores.filter((_, index) => compatible[index]));
  const normalizeKeyword = minMaxNormalizer(keywordScores);
  return candidates.map((chunk, index) => {
    const cosineScore = cosineScores[index];
    const keywordScore = keywordScores[index];
    const hitAlpha = compatible[index] ? alpha : 0;
    const score = hitAlpha * normalizeCosine(cosineScore) + (1 - hitAlpha) * normalizeKeyword(keywordScore);
    const vectorScoreUsed = compatible[index] && alpha > 0;
    const retrievalMode = vectorScoreUsed ? querySpace?.model === 'hash' ? 'hybrid-hash' : 'hybrid-semantic' : 'bm25';
    return { ...chunk, score, cosineScore, keywordScore, vectorScoreUsed, retrievalMode };
  });
}

export function distinctSources<T extends RagDocumentChunk>(hits: readonly T[], limit: number): T[] {
  const seenSources = new Set<string>();
  const distinct: T[] = [];
  for (const hit of hits) {
    if (seenSources.has(hit.filePath)) continue;
    seenSources.add(hit.filePath);
    distinct.push(hit);
    if (distinct.length === limit) break;
  }
  return distinct;
}
