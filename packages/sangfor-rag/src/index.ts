import { statSync } from 'node:fs';
import { basename } from 'node:path';
import { normalizeProduct, nowId, withDirLock, writeFileAtomicSync } from '@sangfor/shared';
import { chunkText, extractTextFromFile } from './document-extraction.js';
import { embedForRole, getEmbeddingProvider } from './embedding-provider.js';
import type { EmbeddingBackend } from './embedding-provider-types.js';
import { hashEmbedding } from './hash-embedding.js';
import { actualEmbeddingModelName, ragChunkContentHash } from './rag-ingest.js';
import {
  assertLocalRagAuthorityAllowed,
  DEFAULT_INDEX_PATH,
  encodeVectorB64,
  loadRagIndexWithParser,
  ragIndexCache,
  type StoredRagChunk,
} from './rag-index-store.js';
import { parseBoundaryRagIndexV1 } from './runtime-boundaries.js';
import type { IngestDocumentInput, RagDocumentChunk, RagIndex } from './rag-types.js';

export { hashEmbedding, cosineSimilarity } from './hash-embedding.js';
export { getEmbeddingProvider, resetEmbeddingProviderCache, wasEmbeddingFallback } from './embedding-provider.js';
export type { EmbeddingBackend, EmbeddingProvider, RerankProvider } from './embedding-provider-types.js';
export { computeBm25Scores, tokenize } from './bm25.js';
export { normalizeRetrievalQuery } from './query-normalization.js';
export { extractDocumentBlocks, type DocumentBlock, type DocumentBlockType } from './document-ir.js';
export {
  JsonRagIndexStore,
  listShardedJsonlProducts,
  loadShardedJsonlIndex,
  recommendStorageMigration,
  saveShardedJsonlIndex,
  type RagIndexStore,
  type ShardedJsonlManifest,
  type StorageMigrationPlan,
} from './storage.js';
export type {
  AuthorizedRagScope,
  IngestDocumentInput,
  RagDocumentChunk,
  RagIndex,
  RagSearchDiagnostics,
  RagSearchHit,
  RagSearchInput,
  ScopedRagSearchInput,
} from './rag-types.js';
export { assertLocalRagAuthorityAllowed };
export {
  chunkText,
  extractTextFromDocx,
  extractTextFromFile,
  extractTextFromPdf,
  extractTextFromPptx,
  extractTextFromXlsx,
} from './document-extraction.js';
export { ragChunkContentHash };
export { minMaxNormalizer } from './rag-ranking.js';
export {
  exportRagIndexSummary,
  filterScopedRagCandidates,
  getRagSearchDiagnostics,
  omitVectorFromHit,
  ragSearch,
  ragSearchScopedSync,
  ragSearchSync,
} from './rag-search.js';

export function loadRagIndex(indexPath = DEFAULT_INDEX_PATH): RagIndex {
  return loadRagIndexWithParser(indexPath, (source) => parseBoundaryRagIndexV1(source));
}

function ragIndexLockPath(indexPath: string): string {
  return `${indexPath}.lock`;
}

// The actual write, with no locking of its own — callers that already hold
// the `${indexPath}.lock` mutex (e.g. ingestDocument's load-modify-save) call
// this directly instead of the public saveRagIndex, since withDirLock is not
// reentrant: acquiring the same lock twice from inside its own critical
// section would just wait out its own holder and throw DirLockTimeoutError.
function saveRagIndexUnlocked(index: RagIndex, indexPath: string): void {
  const payload: RagIndex = { ...index, updatedAt: new Date().toISOString() };
  // Compact JSON + base64-f32 vectors on disk (see StoredRagChunk); the cache
  // keeps the hydrated in-memory form so readers never see the stored shape.
  const stored = {
    ...payload,
    chunks: payload.chunks.map(({ vector, ...rest }): StoredRagChunk => ({ ...rest, vectorB64: encodeVectorB64(vector) })),
  };
  writeFileAtomicSync(indexPath, JSON.stringify(stored));
  const stat = statSync(indexPath);
  ragIndexCache.set(indexPath, { mtimeMs: stat.mtimeMs, index: payload });
}

export function saveRagIndex(index: RagIndex, indexPath = DEFAULT_INDEX_PATH): void {
  assertLocalRagAuthorityAllowed(indexPath);
  withDirLock(ragIndexLockPath(indexPath), () => saveRagIndexUnlocked(index, indexPath));
}

export async function ingestDocument(input: IngestDocumentInput): Promise<{ documentId: string; chunkCount: number; indexPath: string; chunks: RagDocumentChunk[]; embeddingBackend: EmbeddingBackend }> {
  const product = normalizeProduct(input.product);
  const text = await extractTextFromFile(input.filePath);
  const title = input.title ?? basename(input.filePath);
  const sourceType = input.sourceType ?? 'manual';
  const trustLevel = input.trustLevel ?? (sourceType === 'manual' ? 'official' : 'internal');
  const documentId = nowId('doc');
  const textChunks = chunkText(text);
  const provider = await getEmbeddingProvider();
  const vectors = await embedForRole(provider, textChunks, 'document');
  const chunks = textChunks.map((chunkTextValue, index): RagDocumentChunk => {
    const contentHash = ragChunkContentHash(input.filePath, index, chunkTextValue);
    const vector = vectors[index] ?? hashEmbedding(chunkTextValue);
    return {
      id: `${documentId}_chunk_${index + 1}`,
      sourceType,
      product,
      version: input.version,
      title,
      section: `chunk-${index + 1}`,
      text: chunkTextValue,
      trustLevel,
      vector,
      contentHash,
      filePath: input.filePath,
      embeddingBackend: provider.name,
      // Record the model that was ACTUALLY used, not the env-configured target —
      // if the configured backend (rapid-mlx/litellm) fell back to hash mid-call,
      // provider.name is already 'hash' here and the metadata must say so too.
      embeddingModel: actualEmbeddingModelName(provider),
      vectorDims: vector.length
    };
  });
  const indexPath = input.indexPath ?? DEFAULT_INDEX_PATH;
  assertLocalRagAuthorityAllowed(indexPath);
  // Hold the same lock saveRagIndex uses across the whole load→dedupe→mutate→
  // save sequence — without it, two concurrent ingestDocument calls can both
  // load the pre-mutation index, each append their own chunks on top of that
  // stale snapshot, and whichever saves last silently discards the other's
  // chunks (last-writer-wins data loss, not a crash — the dangerous kind).
  const { newChunks } = withDirLock(ragIndexLockPath(indexPath), () => {
    const index = loadRagIndex(indexPath);
    const existingHashes = new Set(index.chunks.map(chunk => chunk.contentHash));
    const newChunks = chunks.filter(chunk => !existingHashes.has(chunk.contentHash));
    if (newChunks.length === 0) return { newChunks };
    const hasSemantic = newChunks.some(c => c.embeddingBackend && c.embeddingBackend !== 'hash');
    index.version = hasSemantic ? 2 : index.version;
    index.chunks.push(...newChunks);
    saveRagIndexUnlocked(index, indexPath); // NOT saveRagIndex — we already hold this lock
    return { newChunks };
  });
  if (newChunks.length === 0) {
    return { documentId, chunkCount: 0, indexPath, chunks: [], embeddingBackend: provider.name };
  }
  return { documentId, chunkCount: newChunks.length, indexPath, chunks: newChunks, embeddingBackend: provider.name };
}

export async function ingestDocumentsBatch(inputs: IngestDocumentInput[]): Promise<{
  documentCount: number;
  chunkCount: number;
  indexPath: string;
  embeddingBackend: EmbeddingBackend;
}> {
  if (inputs.length === 0) {
    return {
      documentCount: 0,
      chunkCount: 0,
      indexPath: DEFAULT_INDEX_PATH,
      embeddingBackend: 'hash'
    };
  }
  const indexPath = inputs[0].indexPath ?? DEFAULT_INDEX_PATH;
  if (inputs.some((input) => (input.indexPath ?? DEFAULT_INDEX_PATH) !== indexPath)) {
    throw new Error('BATCH_RAG_INDEX_PATH_MISMATCH');
  }
  assertLocalRagAuthorityAllowed(indexPath);
  const provider = await getEmbeddingProvider();
  const chunks: RagDocumentChunk[] = [];
  for (const input of inputs) {
    const text = await extractTextFromFile(input.filePath);
    const title = input.title ?? basename(input.filePath);
    const sourceType = input.sourceType ?? 'manual';
    const trustLevel = input.trustLevel ?? (sourceType === 'manual' ? 'official' : 'internal');
    const product = normalizeProduct(input.product);
    const textChunks = chunkText(text);
    const vectors = await provider.embed(textChunks);
    const documentId = nowId('doc');
    chunks.push(...textChunks.map((chunkTextValue, index): RagDocumentChunk => ({
      id: `${documentId}_chunk_${index + 1}`,
      sourceType,
      product,
      version: input.version,
      title,
      section: `chunk-${index + 1}`,
      text: chunkTextValue,
      trustLevel,
      vector: vectors[index] ?? hashEmbedding(chunkTextValue),
      contentHash: ragChunkContentHash(input.filePath, index, chunkTextValue),
      filePath: input.filePath,
      embeddingBackend: provider.name,
      embeddingModel: actualEmbeddingModelName(provider),
      vectorDims: (vectors[index] ?? hashEmbedding(chunkTextValue)).length
    })));
  }
  const { chunkCount } = withDirLock(ragIndexLockPath(indexPath), () => {
    const index = loadRagIndex(indexPath);
    const existingHashes = new Set(index.chunks.map((chunk) => chunk.contentHash));
    const newChunks = chunks.filter((chunk) => !existingHashes.has(chunk.contentHash));
    if (newChunks.length === 0) return { chunkCount: 0 };
    if (newChunks.some((chunk) => chunk.embeddingBackend !== 'hash')) index.version = 2;
    index.chunks.push(...newChunks);
    saveRagIndexUnlocked(index, indexPath);
    return { chunkCount: newChunks.length };
  });
  return {
    documentCount: inputs.length,
    chunkCount,
    indexPath,
    embeddingBackend: provider.name
  };
}
