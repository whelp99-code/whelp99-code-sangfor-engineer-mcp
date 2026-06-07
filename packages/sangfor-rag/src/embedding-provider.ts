/**
 * Embedding provider chain — design: docs/design/RAG_SEMANTIC_EMBEDDINGS.md
 * Phase 1: hash only. Rapid-MLX + MiniMax wired in Phase 2.
 */
import { hashEmbedding } from './index.js';

export type EmbeddingBackend = 'rapid-mlx' | 'minimax' | 'hash';

export interface EmbeddingProvider {
  readonly name: EmbeddingBackend;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
}

export class HashEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'hash' as const;
  readonly dimensions = 384;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(t => hashEmbedding(t, this.dimensions));
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true, detail: 'deterministic hash buckets' };
  }
}

export function resolveEmbeddingBackendFromEnv(): EmbeddingBackend {
  const raw = (process.env.SANGFOR_EMBEDDING_PROVIDER ?? 'rapid-mlx').trim().toLowerCase();
  if (raw === 'minimax' || raw === 'hash') return raw;
  return 'rapid-mlx';
}

/** Factory — Phase 2 adds RapidMLXProvider + MiniMaxProvider with fallback chain. */
export function createEmbeddingProviderFromEnv(): EmbeddingProvider {
  const requested = resolveEmbeddingBackendFromEnv();
  if (requested !== 'hash' && process.env.SANGFOR_EMBEDDING_FORCE_HASH === '1') {
    return new HashEmbeddingProvider();
  }
  // Phase 2: try rapid-mlx → minimax → hash
  return new HashEmbeddingProvider();
}
