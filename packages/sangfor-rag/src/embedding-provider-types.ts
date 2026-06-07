export type EmbeddingBackend = 'rapid-mlx' | 'mimo' | 'hash';

export interface EmbeddingProvider {
  readonly name: EmbeddingBackend;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
}

export interface RerankProvider {
  readonly name: 'mimo';
  rerank(
    query: string,
    candidates: Array<{ id: string; text: string; title?: string }>,
    topK: number
  ): Promise<string[]>;
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
}
