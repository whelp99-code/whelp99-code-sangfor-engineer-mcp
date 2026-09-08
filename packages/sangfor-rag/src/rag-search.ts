import type { AuthorizationResult } from '@sangfor/identity';
import type { ProductCode } from '@sangfor/shared';
import { resolveRagProduct } from './rag-product.js';
import { RuntimeSchemaError } from '../../shared/src/runtime-schema.js';
import { embedForRole, getEmbeddingProvider, wasEmbeddingFallback } from './embedding-provider.js';
import type { EmbeddingBackend } from './embedding-provider-types.js';
import { hashEmbedding } from './hash-embedding.js';
import { isMimoViaLitellm } from './litellm-config.js';
import { createMimoRerankFromEnv } from './mimo-rerank-provider.js';
import { normalizeRetrievalQuery } from './query-normalization.js';
import { loadRagIndex } from './index.js';
import { DEFAULT_INDEX_PATH } from './rag-index-store.js';
import { canCompareVector, distinctSources, rankHybrid } from './rag-ranking.js';
import { embeddingSpaceId, resolveEmbeddingSpace, type EmbeddingSpace } from './embedding-space.js';
import { actualEmbeddingModelName } from './rag-ingest.js';
import type {
  RagDocumentChunk,
  RagIndex,
  RagSearchDiagnostics,
  RagSearchHit,
  RagSearchInput,
  ScopedRagSearchInput,
} from './rag-types.js';

let lastRagSearchDiagnostics: RagSearchDiagnostics = { degraded: false };
const resultDiagnostics = new WeakMap<readonly RagSearchHit[], RagSearchDiagnostics>();

export function getRagSearchDiagnostics(hits?: readonly RagSearchHit[]): RagSearchDiagnostics {
  return hits ? resultDiagnostics.get(hits) ?? { degraded: true, degradedReason: 'diagnostics unavailable for this result' } : lastRagSearchDiagnostics;
}

function withDiagnostics(hits: RagSearchHit[], diagnostics: RagSearchDiagnostics): RagSearchHit[] {
  const actual = { ...diagnostics, retrievalMode: hits.some((hit) => hit.retrievalMode === 'hybrid-semantic')
    ? 'hybrid-semantic' as const : hits.some((hit) => hit.retrievalMode === 'hybrid-hash') ? 'hybrid-hash' as const : 'bm25' as const };
  resultDiagnostics.set(hits, actual);
  lastRagSearchDiagnostics = actual;
  return hits;
}

function countBy<T extends string | number>(items: readonly T[]): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    const key = String(item);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function computeRagSearchDiagnostics(
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

export function omitVectorFromHit<T extends { vector: number[] }>(hit: T): Omit<T, 'vector'> {
  const { vector, ...rest } = hit;
  return rest;
}

export async function ragSearch(input: RagSearchInput): Promise<RagSearchHit[]> {
  const index = loadRagIndex(input.indexPath);
  const product = input.product ? resolveRagProduct(input.product) : undefined;
  const provider = await getEmbeddingProvider();
  const normalizedQuery = normalizeRetrievalQuery(input.query);
  let queryVector: number[] = [];
  let querySpace: EmbeddingSpace | undefined;
  let embeddingFailure = false;
  try {
    [queryVector] = await embedForRole(provider, [normalizedQuery], 'query');
    querySpace = wasEmbeddingFallback() ? undefined
      : resolveEmbeddingSpace(actualEmbeddingModelName(provider), queryVector.length, provider.name);
  } catch {
    // A provider can fail after its health check. Keep the document search explicitly lexical.
    embeddingFailure = true;
  }
  const finalLimit = input.limit ?? 8;
  if (!Number.isInteger(finalLimit) || finalLimit < 1 || finalLimit > 100) throw new Error('RAG_LIMIT_INVALID');
  const configuredCandidates = Number(process.env.SANGFOR_MIMO_RERANK_CANDIDATES ?? 40);
  const candidateLimit = Math.max(finalLimit, Number.isInteger(configuredCandidates) && configuredCandidates > 0
    ? Math.min(configuredCandidates, 100) : 40);
  const allowCustomer = process.env.SANGFOR_ALLOW_CLOUD_RAG_CUSTOMER === '1';
  const filtered = index.chunks
    .filter((chunk) => !chunk.tenantId && !chunk.projectId)
    .filter((chunk) => !product || chunk.product === product)
    .filter((chunk) => !input.version || chunk.version === input.version)
    .filter((chunk) => !input.sourceType || chunk.sourceType === input.sourceType)
    .filter((chunk) => !input.trustLevel || chunk.trustLevel === input.trustLevel)
    .filter((chunk) => allowCustomer || chunk.trustLevel !== 'customer');

  let diagnostics = computeRagSearchDiagnostics(
    { ...index, chunks: filtered },
    wasEmbeddingFallback() || embeddingFailure,
    provider.name,
    queryVector.length,
    querySpace,
    queryVector,
  );
  const ranked = rankHybrid(filtered, queryVector, normalizedQuery, querySpace).sort((left, right) => right.score - left.score);
  let pool = distinctSources(ranked, candidateLimit);
  const reranker = createMimoRerankFromEnv();
  if (reranker && pool.length > 1) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const configuredTimeout = Number(process.env.SANGFOR_MIMO_RERANK_TIMEOUT_MS ?? '5000');
      const rerankTimeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? Math.min(configuredTimeout, 60_000) : 5000;
      const rankedIds = await Promise.race([
        reranker.rerank(
          normalizedQuery,
          pool.map((chunk) => ({ id: chunk.id, text: chunk.text, title: chunk.title })),
          finalLimit,
          controller.signal,
        ),
        new Promise<string[]>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('rerank-timeout')); }, rerankTimeoutMs); }),
      ]);
      const knownIds = new Set(pool.map((chunk) => chunk.id));
      const uniqueIds = [...new Set(rankedIds)];
      if (!uniqueIds.length || uniqueIds.some((id) => !knownIds.has(id))) throw new Error('RAG_RERANK_IDS_INVALID');
      const order = new Map(uniqueIds.map((id, index) => [id, uniqueIds.length - index]));
      if (uniqueIds.length < Math.min(finalLimit, pool.length)) diagnostics = { ...diagnostics, degraded: true,
        degradedReason: [diagnostics.degradedReason, 'partial rerank; remaining retrieval order retained'].filter(Boolean).join('; ') };
      pool = pool.sort((left, right) => (order.get(right.id) ?? 0) - (order.get(left.id) ?? 0))
        .map((chunk) => order.has(chunk.id) ? { ...chunk, rerankScore: order.get(chunk.id) } : chunk);
      return withDiagnostics(distinctSources(pool, finalLimit), diagnostics);
    } catch (error) {
        diagnostics = {
          ...diagnostics,
          degraded: true,
          degradedReason: [diagnostics.degradedReason, error instanceof RuntimeSchemaError
            ? 'rerank response was INDETERMINATE under its strict runtime schema'
            : 'reranker unavailable; original retrieval order retained'].filter(Boolean).join('; '),
        };
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
  }
  return withDiagnostics(distinctSources(ranked, finalLimit), diagnostics);
}

export function filterScopedRagCandidates(
  chunks: readonly RagDocumentChunk[],
  authorization: AuthorizationResult,
): RagDocumentChunk[] {
  if (!authorization.ok || authorization.scope.permission !== 'rag:read') {
    throw new Error('RAG_SCOPE_UNAUTHORIZED');
  }
  const scope = authorization.scope;
  return chunks.filter((chunk) => chunk.tenantId === scope.tenantId
    && chunk.projectId === scope.projectId
    && (!chunk.aclActorIds || chunk.aclActorIds.length === 0 || chunk.aclActorIds.includes(scope.actorId)));
}

export function ragSearchScopedSync(input: ScopedRagSearchInput): RagSearchHit[] {
  const product = input.product ? resolveRagProduct(input.product) : undefined;
  const normalizedQuery = normalizeRetrievalQuery(input.query);
  const authorized = filterScopedRagCandidates(input.chunks, input.authorization)
    .filter((chunk) => !product || chunk.product === product)
    .filter((chunk) => !input.version || chunk.version === input.version)
    .filter((chunk) => !input.sourceType || chunk.sourceType === input.sourceType)
    .filter((chunk) => !input.trustLevel || chunk.trustLevel === input.trustLevel)
    .filter((chunk) => process.env.SANGFOR_ALLOW_CLOUD_RAG_CUSTOMER === '1' || chunk.trustLevel !== 'customer');
  input.onCandidates?.(authorized);
  const queryVector = hashEmbedding(normalizedQuery);
  const space = resolveEmbeddingSpace('hash', queryVector.length, 'hash');
  return withDiagnostics(rankHybrid(authorized, queryVector, normalizedQuery, space)
    .sort((left, right) => right.score - left.score)
    .slice(0, input.limit ?? 8), computeRagSearchDiagnostics({ version: 1, chunks: authorized, updatedAt: '' }, false, 'hash', queryVector.length, space, queryVector));
}

export function ragSearchSync(input: RagSearchInput): RagSearchHit[] {
  const index = loadRagIndex(input.indexPath);
  const product = input.product ? resolveRagProduct(input.product) : undefined;
  const normalizedQuery = normalizeRetrievalQuery(input.query);
  const queryVector = hashEmbedding(normalizedQuery);
  const filtered = index.chunks
    .filter((chunk) => !chunk.tenantId && !chunk.projectId)
    .filter((chunk) => !product || chunk.product === product)
    .filter((chunk) => !input.version || chunk.version === input.version)
    .filter((chunk) => !input.sourceType || chunk.sourceType === input.sourceType)
    .filter((chunk) => !input.trustLevel || chunk.trustLevel === input.trustLevel)
    .filter((chunk) => process.env.SANGFOR_ALLOW_CLOUD_RAG_CUSTOMER === '1' || chunk.trustLevel !== 'customer');
  const querySpace = resolveEmbeddingSpace('hash', queryVector.length, 'hash');
  const diagnostics = computeRagSearchDiagnostics({ ...index, chunks: filtered }, false, 'hash', queryVector.length, querySpace, queryVector);
  return withDiagnostics(distinctSources(
    rankHybrid(filtered, queryVector, normalizedQuery, querySpace).sort((left, right) => right.score - left.score),
    input.limit ?? 8,
  ), diagnostics);
}

export function exportRagIndexSummary(indexPath = DEFAULT_INDEX_PATH): Record<string, unknown> {
  const index = loadRagIndex(indexPath);
  const byProduct: Partial<Record<ProductCode, number>> = {};
  for (const chunk of index.chunks) byProduct[chunk.product] = (byProduct[chunk.product] ?? 0) + 1;
  const embeddingBackendCounts = countBy(index.chunks.map((chunk) => chunk.embeddingBackend ?? 'hash'));
  const hashChunks = index.chunks.filter((chunk) => (chunk.embeddingBackend ?? 'hash') === 'hash').length;
  const semanticChunks = index.chunks.length - hashChunks;
  const hashRatio = index.chunks.length > 0 ? hashChunks / index.chunks.length : 0;
  return {
    indexPath,
    indexVersion: index.version ?? 1,
    chunkCount: index.chunks.length,
    byProduct,
    embeddingBackendCounts,
    hashChunks,
    semanticChunks,
    hashRatio,
    backends: embeddingBackendCounts,
    mimoRerankEnabled: process.env.SANGFOR_MIMO_RERANK_ENABLED !== '0'
      && (process.env.SANGFOR_ALLOW_CLOUD_RAG === '1' || isMimoViaLitellm()),
    updatedAt: index.updatedAt,
  };
}
