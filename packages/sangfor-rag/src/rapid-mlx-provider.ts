import { fetchOpenAIEmbeddings } from './openai-embeddings-client.js';
import type { EmbeddingBackend, EmbeddingProvider } from './embedding-provider-types.js';
import { HashEmbeddingProvider } from './hash-embedding.js';

export class RapidMlxEmbeddingProvider implements EmbeddingProvider {
  readonly name: EmbeddingBackend = 'rapid-mlx';
  readonly dimensions: number;
  readonly model: string;

  constructor(
    private readonly baseUrl: string,
    model: string,
    private readonly apiKey?: string,
    private readonly batchSize = 16,
    private readonly timeoutMs = 120_000,
    dimensions = 768
  ) {
    this.model = model;
    this.dimensions = dimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const { vectors } = await fetchOpenAIEmbeddings(batch, {
        baseUrl: this.baseUrl,
        apiKey: this.apiKey,
        model: this.model,
        timeoutMs: this.timeoutMs
      });
      out.push(...vectors);
    }
    if (out[0]?.length) (this as { dimensions: number }).dimensions = out[0].length;
    return out;
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const [v] = await this.embed(['health']);
      return { ok: v.length > 0, detail: `${this.model} dims=${v.length}` };
    } catch (err) {
      return { ok: false, detail: String(err) };
    }
  }
}

export async function createRapidMlxWithFallback(): Promise<EmbeddingProvider> {
  const baseUrl = process.env.SANGFOR_RAPID_MLX_BASE_URL ?? 'http://127.0.0.1:8000/v1';
  const model = process.env.SANGFOR_RAPID_MLX_EMBEDDING_MODEL ?? 'mlx-community/nomic-embed-text-v1.5-4bit';
  const provider = new RapidMlxEmbeddingProvider(
    baseUrl,
    model,
    process.env.SANGFOR_RAPID_MLX_API_KEY?.trim(),
    Number(process.env.SANGFOR_RAPID_MLX_BATCH_SIZE ?? 16),
    Number(process.env.SANGFOR_RAPID_MLX_TIMEOUT_MS ?? 120_000)
  );
  const health = await provider.healthCheck();
  if (health.ok) return provider;
  return new HashEmbeddingProvider();
}
