import { createHash } from 'node:crypto';
import { resolveEmbeddingModelFromEnv } from './embedding-provider.js';
import type { EmbeddingProvider } from './embedding-provider-types.js';

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
