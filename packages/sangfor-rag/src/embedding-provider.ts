/**
 * Embedding provider chain — docs/design/RAG_SEMANTIC_EMBEDDINGS.md
 */
import { HashEmbeddingProvider } from './hash-embedding.js';
import { createRapidMlxWithFallback } from './rapid-mlx-provider.js';

export type { EmbeddingBackend, EmbeddingProvider, RerankProvider } from './embedding-provider-types.js';

export { HashEmbeddingProvider } from './hash-embedding.js';

export function resolveEmbeddingBackendFromEnv(): import('./embedding-provider-types.js').EmbeddingBackend {
  const raw = (process.env.SANGFOR_EMBEDDING_PROVIDER ?? 'rapid-mlx').trim().toLowerCase();
  if (raw === 'mimo' || raw === 'hash') return raw;
  return 'rapid-mlx';
}

let cachedProvider: import('./embedding-provider-types.js').EmbeddingProvider | undefined;

export async function getEmbeddingProvider(): Promise<import('./embedding-provider-types.js').EmbeddingProvider> {
  if (cachedProvider) return cachedProvider;
  if (process.env.SANGFOR_EMBEDDING_FORCE_HASH === '1') {
    cachedProvider = new HashEmbeddingProvider();
    return cachedProvider;
  }
  const requested = resolveEmbeddingBackendFromEnv();
  if (requested === 'hash') {
    cachedProvider = new HashEmbeddingProvider();
    return cachedProvider;
  }
  cachedProvider = await createRapidMlxWithFallback();
  return cachedProvider;
}

export function resetEmbeddingProviderCache(): void {
  cachedProvider = undefined;
}

export function createEmbeddingProviderFromEnv(): HashEmbeddingProvider {
  return new HashEmbeddingProvider();
}
