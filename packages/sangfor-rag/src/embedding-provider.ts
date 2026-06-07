/**
 * Embedding provider chain — design: docs/design/RAG_SEMANTIC_EMBEDDINGS.md
 * Phase 1: hash only. Phase 2: Rapid-MLX embed + Xiaomi MiMo rerank at query time.
 */
import { hashEmbedding } from './index.js';

export type EmbeddingBackend = 'rapid-mlx' | 'mimo' | 'hash';

export interface EmbeddingProvider {
  readonly name: EmbeddingBackend;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
}

/** Query-time rerank via MiMo chat API (Xiaomi — not MiniMax). */
export interface RerankProvider {
  readonly name: 'mimo';
  rerank(
    query: string,
    candidates: Array<{ id: string; text: string }>,
    topK: number
  ): Promise<string[]>;
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
  if (raw === 'mimo' || raw === 'hash') return raw;
  return 'rapid-mlx';
}

/** Factory — Phase 2 adds RapidMLXProvider; MiMo used for rerank, not ingest vectors in v1. */
export function createEmbeddingProviderFromEnv(): EmbeddingProvider {
  const requested = resolveEmbeddingBackendFromEnv();
  if (requested !== 'hash' && process.env.SANGFOR_EMBEDDING_FORCE_HASH === '1') {
    return new HashEmbeddingProvider();
  }
  // Phase 2: rapid-mlx → hash (ingest). Query: + optional MiMo rerank.
  return new HashEmbeddingProvider();
}
