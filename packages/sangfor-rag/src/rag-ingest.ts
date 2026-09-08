import { createHash } from 'node:crypto';
import { resolveEmbeddingModelFromEnv } from './embedding-provider.js';
import type { EmbeddingProvider } from './embedding-provider-types.js';
import type { RagDocumentChunk } from './rag-types.js';
import { sameEmbeddingSpace } from './embedding-space.js';

export function ragChunkContentHash(filePath: string, chunkIndex: number, text: string): string {
  return createHash('sha256').update(`${filePath}:${chunkIndex}:${text}`).digest('hex');
}

export function actualEmbeddingModelName(provider: EmbeddingProvider): string {
  if (provider.name === 'hash') return 'hash';
  if ('model' in provider && typeof provider.model === 'string' && provider.model.trim()) {
    return provider.model;
  }
  return resolveEmbeddingModelFromEnv();
}

/** Replace one source revision atomically; unchanged sources retain stable chunk ids. */
export function replaceDocumentRevisions(
  existing: readonly RagDocumentChunk[], incoming: readonly RagDocumentChunk[], filePaths: readonly string[],
): { chunks: RagDocumentChunk[]; replacements: RagDocumentChunk[]; changed: boolean } {
  const changedPaths = new Set<string>();
  for (const filePath of filePaths) {
    const before = existing.filter((chunk) => chunk.filePath === filePath);
    const after = incoming.filter((chunk) => chunk.filePath === filePath);
    const unchanged = before.length === after.length && before.every((old, index) => {
      const next = after[index];
      return old.contentHash === next.contentHash && old.product === next.product && old.version === next.version
        && old.title === next.title && old.sourceType === next.sourceType && old.trustLevel === next.trustLevel
        && old.embeddingModel === next.embeddingModel && old.embeddingBackend === next.embeddingBackend
        && old.vectorDims === next.vectorDims
        && ((old.embeddingSpace === undefined && next.embeddingSpace === undefined) || sameEmbeddingSpace(old.embeddingSpace, next.embeddingSpace));
    });
    if (!unchanged) changedPaths.add(filePath);
  }
  const replacements = incoming.filter((chunk) => changedPaths.has(chunk.filePath));
  return {
    chunks: [...existing.filter((chunk) => !changedPaths.has(chunk.filePath)), ...replacements],
    replacements, changed: changedPaths.size > 0,
  };
}
