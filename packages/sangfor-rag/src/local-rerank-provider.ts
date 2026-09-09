import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { RerankProvider } from './embedding-provider-types.js';
import { retrievalBody, selectRetrievalSnippet } from './retrieval-text.js';

const configurationSchema = z.object({
  maxLength: z.number().int().min(128).max(4096),
  dtype: z.enum(['auto', 'float32']),
  batchSize: z.number().int().min(1).max(32),
  instruction: z.string().max(2048).refine((value) => value.trim().length > 0).optional(),
}).strict().refine((value) => value.maxLength * value.batchSize <= 16384);
export type LocalRerankConfiguration = z.infer<typeof configurationSchema>;
export function localRerankConfigurationDigest(model: string, revision: string, raw: LocalRerankConfiguration): string {
  const config = configurationSchema.parse(raw);
  return createHash('sha256').update(JSON.stringify([model, revision, config.maxLength, config.dtype,
    config.batchSize, config.instruction ?? null])).digest('hex');
}

export function localRerankMinimumScoreFromEnv(): number | undefined {
  const raw = process.env.SANGFOR_LOCAL_RERANK_MIN_SCORE;
  if (raw === undefined) return undefined;
  if (!raw.trim()) throw new Error('RAG_LOCAL_RERANK_MIN_SCORE_INVALID');
  const score = Number(raw);
  if (!Number.isFinite(score)) throw new Error('RAG_LOCAL_RERANK_MIN_SCORE_INVALID');
  return score;
}

const responseSchema = z.object({ model: z.string(), revision: z.string(),
  configurationSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  results: z.array(z.object({ index: z.number().int().nonnegative(), score: z.number().finite() }).strict()).min(1),
}).strict();

export class LocalRerankProvider implements RerankProvider {
  readonly name = 'local-cross-encoder' as const;
  /** Configured scoring identity, not proof that inference ran successfully. */
  readonly configurationSha256?: string;
  constructor(private readonly baseUrl: string, private readonly model: string, private readonly revision: string, configuration?: LocalRerankConfiguration, readonly minimumScore?: number) {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('RAG_LOCAL_RERANK_LOOPBACK_REQUIRED');
    if (!model.trim() || !/^[a-f0-9]{40}$/.test(revision)) throw new Error('RAG_LOCAL_RERANK_IDENTITY_REQUIRED');
    if (configuration) this.configurationSha256 = localRerankConfigurationDigest(model, revision, configuration);
    if (minimumScore !== undefined && (!Number.isFinite(minimumScore) || !configuration)) throw new Error('RAG_LOCAL_RERANK_SCORE_GATE_CONFIGURATION_REQUIRED');
  }
  async rerank(query: string, candidates: Array<{ id: string; text: string; title?: string }>, topK: number, signal?: AbortSignal): Promise<string[]> {
    return (await this.rerankScored(query, candidates, topK, signal))
      .filter((row) => this.minimumScore === undefined || row.score >= this.minimumScore).map((row) => row.id);
  }
  /** Model scores are retained verbatim; their scale is not a calibrated answer probability. */
  async rerankScored(query: string, candidates: Array<{ id: string; text: string; title?: string }>, topK: number, signal?: AbortSignal): Promise<Array<{ id: string; score: number }>> {
    if (!candidates.length) return [];
    const result = await fetch(`${this.baseUrl.replace(/\/$/, '')}/rerank`, {
      method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
      body: JSON.stringify({ model: this.model, query,
        documents: candidates.map((candidate) => `${candidate.title ?? ''}\n${selectRetrievalSnippet(query, retrievalBody(candidate.text, candidate.title ?? ''))}`),
        top_n: Math.min(topK, candidates.length) }),
    });
    if (!result.ok) throw new Error(`RAG_LOCAL_RERANK_HTTP_${result.status}`);
    const parsed = responseSchema.parse(await result.json());
    if (parsed.model !== this.model || parsed.revision !== this.revision) throw new Error('RAG_LOCAL_RERANK_IDENTITY_MISMATCH');
    if (this.configurationSha256 && parsed.configurationSha256 !== this.configurationSha256) throw new Error('RAG_LOCAL_RERANK_CONFIGURATION_MISMATCH');
    const indexes = parsed.results.map((row) => row.index);
    if (indexes.some((index) => index >= candidates.length) || new Set(indexes).size !== indexes.length) throw new Error('RAG_LOCAL_RERANK_INDEX_INVALID');
    return [...parsed.results].sort((a, b) => b.score - a.score || a.index - b.index).slice(0, topK).map((row) => ({ id: candidates[row.index].id, score: row.score }));
  }
  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/health`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
      const data = await response.json() as { ok?: boolean; model?: string; revision?: string; configurationSha256?: string };
      return { ok: response.ok && data.ok === true && data.model === this.model && data.revision === this.revision
        && (!this.configurationSha256 || data.configurationSha256 === this.configurationSha256) };
    } catch { return { ok: false, detail: 'local reranker unavailable' }; }
  }
}

export function createLocalRerankFromEnv(): LocalRerankProvider | undefined {
  const minimumScore = localRerankMinimumScoreFromEnv();
  if (process.env.SANGFOR_LOCAL_RERANK_ENABLED !== '1') {
    if (minimumScore !== undefined) throw new Error('RAG_LOCAL_RERANK_SCORE_GATE_REQUIRES_ENABLED_PROVIDER');
    return undefined;
  }
  const configuration = configurationSchema.parse({
    maxLength: Number(process.env.SANGFOR_LOCAL_RERANK_MAX_LENGTH ?? 512),
    dtype: process.env.SANGFOR_LOCAL_RERANK_DTYPE ?? 'auto',
    batchSize: Number(process.env.SANGFOR_LOCAL_RERANK_BATCH_SIZE ?? 16),
    instruction: process.env.SANGFOR_LOCAL_RERANK_INSTRUCTION,
  });
  return new LocalRerankProvider(process.env.SANGFOR_LOCAL_RERANK_URL ?? 'http://127.0.0.1:8005',
    process.env.SANGFOR_LOCAL_RERANK_MODEL ?? '', process.env.SANGFOR_LOCAL_RERANK_REVISION ?? '', configuration, minimumScore);
}
