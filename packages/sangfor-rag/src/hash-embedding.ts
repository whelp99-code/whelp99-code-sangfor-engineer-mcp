import { createHash } from 'node:crypto';
import type { EmbeddingProvider } from './embedding-provider-types.js';

export function hashEmbedding(text: string, dims = 384): number[] {
  const vector = Array.from({ length: dims }, () => 0);
  const tokens = text.toLowerCase().match(/[a-z0-9가-힣._/-]+/g) ?? [];
  for (const token of tokens) {
    const digest = createHash('sha256').update(token).digest();
    const bucket = ((digest[0] << 8) + digest[1]) % dims;
    vector[bucket] += digest[2] % 2 === 0 ? 1 : -1;
  }
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vector.map(v => v / norm);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < len; i += 1) sum += a[i] * b[i];
  return sum;
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
