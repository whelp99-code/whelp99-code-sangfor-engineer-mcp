import type { AuthorizationResult } from '@sangfor/identity';
import type { ProductCode } from '@sangfor/shared';
import { normalizeProduct } from '@sangfor/shared';
import { RuntimeSchemaError } from '../../shared/src/runtime-schema.js';
import { embedForRole, getEmbeddingProvider, wasEmbeddingFallback } from './embedding-provider.js';
import type { EmbeddingBackend } from './embedding-provider-types.js';
import { hashEmbedding } from './hash-embedding.js';
import { isMimoViaLitellm } from './litellm-config.js';
import { createMimoRerankFromEnv } from './mimo-rerank-provider.js';
import { normalizeRetrievalQuery } from './query-normalization.js';
import { loadRagIndex } from './index.js';
import { DEFAULT_INDEX_PATH } from './rag-index-store.js';
import { distinctSources, rankHybrid } from './rag-ranking.js';
import type {
  RagDocumentChunk,
  RagIndex,
  RagSearchDiagnostics,
  RagSearchHit,
  RagSearchInput,
  ScopedRagSearchInput,
} from './rag-types.js';

let lastRagSearchDiagnostics: RagSearchDiagnostics = { degraded: false };

export function getRagSearchDiagnostics(): RagSearchDiagnostics {
  return lastRagSearchDiagnostics;
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
  };
  return reasons.length > 0 ? { ...diagnostics, degradedReason: reasons.join('; ') } : diagnostics;
}

export function omitVectorFromHit<T extends { vector: number[] }>(hit: T): Omit<T, 'vector'> {
  const { vector, ...rest } = hit;
  return rest;
}

export async function ragSearch(input: RagSearchInput): Promise<RagSearchHit[]> {
  const index = loadRagIndex(input.indexPath);
  const product = input.product ? normalizeProduct(input.product) : undefined;
  const provider = await getEmbeddingProvider();
  const normalizedQuery = normalizeRetrievalQuery(input.query);
  const [queryVector] = await embedForRole(provider, [normalizedQuery], 'query');
  const candidateLimit = Number(process.env.SANGFOR_MIMO_RERANK_CANDIDATES ?? 40);
  const finalLimit = input.limit ?? 8;
  const allowCustomer = process.env.SANGFOR_ALLOW_CLOUD_RAG_CUSTOMER === '1';
  const filtered = index.chunks
    .filter((chunk) => !product || chunk.product === product)
    .filter((chunk) => !input.version || !chunk.version || chunk.version === input.version)
    .filter((chunk) => !input.sourceType || chunk.sourceType === input.sourceType)
    .filter((chunk) => !input.trustLevel || chunk.trustLevel === input.trustLevel)
    .filter((chunk) => allowCustomer || chunk.trustLevel !== 'customer');

  lastRagSearchDiagnostics = computeRagSearchDiagnostics(
    index,
    wasEmbeddingFallback(),
    provider.name,
    queryVector.length,
  );
  const ranked = rankHybrid(filtered, queryVector, normalizedQuery).sort((left, right) => right.score - left.score);
  let pool = distinctSources(ranked, candidateLimit);
  const reranker = createMimoRerankFromEnv();
  if (reranker && pool.length > 1) {
    try {
      const rerankTimeoutMs = Number(process.env.SANGFOR_MIMO_RERANK_TIMEOUT_MS ?? '5000');
      const rankedIds = await Promise.race([
        reranker.rerank(
          normalizedQuery,
          pool.map((chunk) => ({ id: chunk.id, text: chunk.text, title: chunk.title })),
          finalLimit,
        ),
        new Promise<string[]>((_, reject) => setTimeout(() => reject(new Error('rerank-timeout')), rerankTimeoutMs)),
      ]);
      const order = new Map(rankedIds.map((id, index) => [id, rankedIds.length - index]));
      pool = pool
        .filter((chunk) => order.has(chunk.id))
        .sort((left, right) => (order.get(right.id) ?? 0) - (order.get(left.id) ?? 0))
        .map((chunk, index) => ({ ...chunk, rerankScore: order.get(chunk.id) ?? index }));
      return distinctSources(pool, finalLimit);
    } catch (error) {
      if (error instanceof RuntimeSchemaError) {
        lastRagSearchDiagnostics = {
          ...lastRagSearchDiagnostics,
          degraded: true,
          degradedReason: 'rerank response was INDETERMINATE under its strict runtime schema',
        };
      }
    }
  }
  return distinctSources(ranked, finalLimit);
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
  const product = input.product ? normalizeProduct(input.product) : undefined;
  const normalizedQuery = normalizeRetrievalQuery(input.query);
  const authorized = filterScopedRagCandidates(input.chunks, input.authorization)
    .filter((chunk) => !product || chunk.product === product)
    .filter((chunk) => !input.version || !chunk.version || chunk.version === input.version);
  input.onCandidates?.(authorized);
  return rankHybrid(authorized, hashEmbedding(normalizedQuery), normalizedQuery)
    .sort((left, right) => right.score - left.score)
    .slice(0, input.limit ?? 8);
}

export function ragSearchSync(input: RagSearchInput): RagSearchHit[] {
  const index = loadRagIndex(input.indexPath);
  const product = input.product ? normalizeProduct(input.product) : undefined;
  const normalizedQuery = normalizeRetrievalQuery(input.query);
  const queryVector = hashEmbedding(normalizedQuery);
  const filtered = index.chunks
    .filter((chunk) => !product || chunk.product === product)
    .filter((chunk) => !input.version || !chunk.version || chunk.version === input.version)
    .filter((chunk) => !input.sourceType || chunk.sourceType === input.sourceType)
    .filter((chunk) => !input.trustLevel || chunk.trustLevel === input.trustLevel)
    .filter((chunk) => process.env.SANGFOR_ALLOW_CLOUD_RAG_CUSTOMER === '1' || chunk.trustLevel !== 'customer');
  return distinctSources(
    rankHybrid(filtered, queryVector, normalizedQuery).sort((left, right) => right.score - left.score),
    input.limit ?? 8,
  );
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
