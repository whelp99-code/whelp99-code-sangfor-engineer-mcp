import { retrievalBody, retrievalTitle } from './retrieval-text.js';
import { computeBm25Scores } from './bm25.js';
import { querySubjectTerms } from './query-evidence.js';
import { cosineSimilarity } from './hash-embedding.js';
import { sameEmbeddingSpace, type EmbeddingSpace } from './embedding-space.js';
import type { RagDocumentChunk } from './rag-types.js';

const searchViews = new WeakMap<RagDocumentChunk, { title: string; text: string; body: { id: string; text: string }; heading: { id: string; text: string } }>();
function searchView(chunk: RagDocumentChunk) {
  let view = searchViews.get(chunk);
  if (!view || view.text !== chunk.text || view.title !== chunk.title) {
    view = { title: chunk.title, text: chunk.text,
      body: { id: chunk.id, text: retrievalBody(chunk.text, chunk.title) },
      heading: { id: chunk.id, text: retrievalTitle(chunk.title) } };
    searchViews.set(chunk, view);
  }
  return view;
}

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

/** RRF only admits positive evidence; incompatible vectors never receive a rank. */
export function reciprocalRanks(scores: readonly number[]): number[] {
  const order = scores.map((score, index) => ({ score, index })).filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const ranks = scores.map(() => 0);
  for (let index = 0; index < order.length; index++) ranks[order[index].index] = 1 / (60 + index + 1);
  return ranks;
}

export function hasRetrievalEvidence(hit: { keywordScore: number; cosineScore: number; retrievalMode: string; subjectScore?: number }): boolean {
  if (process.env.SANGFOR_RAG_REQUIRE_SUBJECT_MATCH === '1' && !(hit.subjectScore && hit.subjectScore > 0)) return false;
  return hit.keywordScore > 0 || (hit.retrievalMode === 'hybrid-semantic' && hit.cosineScore > 0);
}

export function rankHybrid<T extends RagDocumentChunk>(
  candidates: readonly T[],
  queryVector: number[],
  query: string,
  querySpace?: EmbeddingSpace,
): Array<T & { readonly score: number; readonly cosineScore: number; readonly keywordScore: number;
  readonly subjectScore?: number; readonly vectorScoreUsed: boolean; readonly retrievalMode: 'hybrid-semantic' | 'hybrid-hash' | 'bm25' }> {
  const compatible = candidates.map((chunk) => canCompareVector(chunk, queryVector, querySpace));
  const alpha = compatible.some(Boolean) ? resolveHybridAlpha() : 0;
  const cosineScores = candidates.map((chunk, index) => compatible[index] ? cosineSimilarity(queryVector, chunk.vector) : 0);
  const views = candidates.map(searchView);
  const bm25Scores = computeBm25Scores(query, views.map((view) => view.body));
  const titleScores = computeBm25Scores(query, views.map((view) => view.heading));
  const subjectScores = process.env.SANGFOR_RAG_REQUIRE_SUBJECT_MATCH === '1'
    ? computeBm25Scores(querySubjectTerms(query).join(' '), views.map((view) => ({ id: view.body.id, text: `${view.heading.text}\n${view.body.text}` }))) : undefined;
  const keywordScores = candidates.map((chunk) => (bm25Scores.get(chunk.id) ?? 0) + 2 * (titleScores.get(chunk.id) ?? 0));
  const normalizeCosine = minMaxNormalizer(cosineScores.filter((_, index) => compatible[index]));
  const normalizeKeyword = minMaxNormalizer(keywordScores);
  const useRrf = process.env.SANGFOR_RAG_FUSION === 'rrf' && compatible.some(Boolean);
  const lexicalRanks = useRrf ? reciprocalRanks(keywordScores) : [];
  const vectorRanks = useRrf ? reciprocalRanks(cosineScores) : [];
  return candidates.map((chunk, index) => {
    const cosineScore = cosineScores[index];
    const keywordScore = keywordScores[index];
    const hitAlpha = compatible[index] ? alpha : 0;
    const score = useRrf
      ? hitAlpha * vectorRanks[index] + (1 - hitAlpha) * lexicalRanks[index]
      : hitAlpha * normalizeCosine(cosineScore) + (1 - hitAlpha) * normalizeKeyword(keywordScore);
    const vectorScoreUsed = compatible[index] && alpha > 0;
    const retrievalMode = vectorScoreUsed ? querySpace?.model === 'hash' ? 'hybrid-hash' : 'hybrid-semantic' : 'bm25';
    return { ...chunk, score, cosineScore, keywordScore, vectorScoreUsed, retrievalMode,
      ...(subjectScores ? { subjectScore: subjectScores.get(chunk.id) ?? 0 } : {}) };
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

/** Retain source diversity while letting a local reranker inspect a second passage. */
export function expandRerankPassages<T extends RagDocumentChunk>(ranked: readonly T[], seeds: readonly T[]): T[] {
  const pool = [...seeds];
  const counts = new Map(seeds.map((hit) => [hit.filePath, 1]));
  const ids = new Set(seeds.map((hit) => hit.id));
  for (const hit of ranked) {
    if (pool.length >= 100) break;
    const count = counts.get(hit.filePath);
    if (count === undefined || count >= 2 || ids.has(hit.id)) continue;
    pool.push(hit); ids.add(hit.id); counts.set(hit.filePath, count + 1);
  }
  return pool;
}
