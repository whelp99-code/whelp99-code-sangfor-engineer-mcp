import { computeBm25Scores } from './bm25.js';
import { cosineSimilarity, hashEmbedding } from './hash-embedding.js';
import type { RagDocumentChunk } from './rag-types.js';

function vectorForSearch(chunk: RagDocumentChunk, queryVector: number[]): number {
  if (chunk.vector.length === queryVector.length) return cosineSimilarity(queryVector, chunk.vector);
  return cosineSimilarity(queryVector, hashEmbedding(chunk.text, queryVector.length));
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
): Array<T & { readonly score: number; readonly cosineScore: number; readonly keywordScore: number }> {
  const alpha = resolveHybridAlpha();
  const cosineScores = candidates.map((chunk) => vectorForSearch(chunk, queryVector));
  const bm25Scores = computeBm25Scores(query, candidates.map((chunk) => ({
    id: chunk.id,
    text: `${chunk.title}\n${chunk.text}`,
  })));
  const keywordScores = candidates.map((chunk) => bm25Scores.get(chunk.id) ?? 0);
  const normalizeCosine = minMaxNormalizer(cosineScores);
  const normalizeKeyword = minMaxNormalizer(keywordScores);
  return candidates.map((chunk, index) => {
    const cosineScore = cosineScores[index];
    const keywordScore = keywordScores[index];
    const score = alpha * normalizeCosine(cosineScore) + (1 - alpha) * normalizeKeyword(keywordScore);
    return { ...chunk, score, cosineScore, keywordScore };
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
