import { computeRagSearchDiagnostics, countBy, withDiagnostics } from './rag-search-diagnostics.js';
export { getRagSearchDiagnostics } from './rag-search-diagnostics.js';
import { attachHitContext } from './hit-context.js';
import { createLocalRerankFromEnv, localRerankMinimumScoreFromEnv } from './local-rerank-provider.js';
import { localScoreOrderFromEnv, orderScoredHits } from './local-score-order.js';
import type { AuthorizationResult } from '@sangfor/identity';
import type { ProductCode } from '@sangfor/shared';
import { resolveRagProduct } from './rag-product.js';
import { RuntimeSchemaError } from '../../shared/src/runtime-schema.js';
import { embedForRole, getEmbeddingProvider, wasEmbeddingFallback } from './embedding-provider.js';
import { hashEmbedding } from './hash-embedding.js';
import { isMimoViaLitellm } from './litellm-config.js';
import { createMimoRerankFromEnv } from './mimo-rerank-provider.js';
import { normalizeRetrievalQuery } from './query-normalization.js';
import { loadRagIndex } from './index.js';
import { DEFAULT_INDEX_PATH } from './rag-index-store.js';
import { distinctSources, expandRerankPassages, hasRetrievalEvidence, rankHybrid } from './rag-ranking.js';
import { resolveEmbeddingSpace, type EmbeddingSpace } from './embedding-space.js';
import { actualEmbeddingModelName } from './rag-ingest.js';
import type {
  RagDocumentChunk,
  RagSearchHit,
  RagSearchInput,
  ScopedRagSearchInput,
} from './rag-types.js';

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
  const ranked = rankHybrid(filtered, queryVector, normalizedQuery, querySpace).filter(hasRetrievalEvidence).sort((left, right) => right.score - left.score);
  let pool = distinctSources(ranked, candidateLimit);
  const localReranker = createLocalRerankFromEnv();
  const minimumScore = localReranker?.minimumScore;
  const scoreOrder = minimumScore !== undefined ? localScoreOrderFromEnv() : undefined;
  if (minimumScore !== undefined && (embeddingFailure || wasEmbeddingFallback())) throw new Error('RAG_SCORE_GATE_RETRIEVAL_UNAVAILABLE');
  const reranker = localReranker ?? createMimoRerankFromEnv();
  if (localReranker && process.env.SANGFOR_LOCAL_RERANK_PASSAGES === '2') pool = expandRerankPassages(ranked, pool);
  if (reranker && (pool.length > 1 || (minimumScore !== undefined && pool.length === 1))) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const configuredTimeout = Number(process.env.SANGFOR_MIMO_RERANK_TIMEOUT_MS ?? '5000');
      const rerankTimeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? Math.min(configuredTimeout, 60_000) : 5000;
      let scored: Array<{ id: string; score: number }> | undefined;
      const request = localReranker && minimumScore !== undefined
        ? localReranker.rerankScored(normalizedQuery, pool, pool.length, controller.signal).then((rows) => {
          if (rows.length !== pool.length) throw new Error('RAG_SCORE_GATE_INCOMPLETE_RESPONSE');
          scored = rows;
          return rows.filter((row) => row.score >= minimumScore).map((row) => row.id);
        }) : reranker.rerank(
          normalizedQuery,
          pool.map((chunk) => ({ id: chunk.id, text: chunk.text, title: chunk.title })),
          localReranker ? pool.length : finalLimit,
          controller.signal,
        );
      const rankedIds = await Promise.race([
        request,
        new Promise<string[]>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('rerank-timeout')); }, rerankTimeoutMs); }),
      ]);
      const knownIds = new Set(pool.map((chunk) => chunk.id));
      const uniqueIds = [...new Set(rankedIds)];
      if (minimumScore !== undefined && scored) {
        if (uniqueIds.some((id) => !knownIds.has(id))) throw new Error('RAG_RERANK_IDS_INVALID');
        const accepted = orderScoredHits(pool, scored, minimumScore, scoreOrder!);
        return withDiagnostics(attachHitContext(distinctSources(accepted, finalLimit), filtered, input.contextNeighbors), diagnostics);
      }
      if (!uniqueIds.length || uniqueIds.some((id) => !knownIds.has(id))) throw new Error('RAG_RERANK_IDS_INVALID');
      const order = new Map(uniqueIds.map((id, index) => [id, uniqueIds.length - index]));
      if (uniqueIds.length < Math.min(finalLimit, pool.length)) diagnostics = { ...diagnostics, degraded: true,
        degradedReason: [diagnostics.degradedReason, 'partial rerank; remaining retrieval order retained'].filter(Boolean).join('; ') };
      pool = pool.sort((left, right) => (order.get(right.id) ?? 0) - (order.get(left.id) ?? 0))
        .map((chunk) => order.has(chunk.id) ? { ...chunk, rerankScore: order.get(chunk.id) } : chunk);
      return withDiagnostics(attachHitContext(distinctSources(pool, finalLimit), filtered, input.contextNeighbors), diagnostics);
    } catch (error) {
        // Unavailable inference is not evidence of no answer. Default MCP results
        // are arrays, so throwing preserves this distinction for every caller.
        if (minimumScore !== undefined) throw new Error('RAG_SCORE_GATE_UNAVAILABLE', { cause: error });
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
  return withDiagnostics(attachHitContext(distinctSources(ranked, finalLimit), filtered, input.contextNeighbors), diagnostics);
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
  if (localRerankMinimumScoreFromEnv() !== undefined) throw new Error('RAG_SCORE_GATE_ASYNC_REQUIRED');
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
  return withDiagnostics(attachHitContext(rankHybrid(authorized, queryVector, normalizedQuery, space).filter(hasRetrievalEvidence)
    .sort((left, right) => right.score - left.score)
    .slice(0, input.limit ?? 8), authorized, input.contextNeighbors), computeRagSearchDiagnostics({ version: 1, chunks: authorized, updatedAt: '' }, false, 'hash', queryVector.length, space, queryVector));
}

export function ragSearchSync(input: RagSearchInput): RagSearchHit[] {
  if (localRerankMinimumScoreFromEnv() !== undefined) throw new Error('RAG_SCORE_GATE_ASYNC_REQUIRED');
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
  return withDiagnostics(attachHitContext(distinctSources(
    rankHybrid(filtered, queryVector, normalizedQuery, querySpace).filter(hasRetrievalEvidence).sort((left, right) => right.score - left.score),
    input.limit ?? 8,
  ), filtered, input.contextNeighbors), diagnostics);
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
