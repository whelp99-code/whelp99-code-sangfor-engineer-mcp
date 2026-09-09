import { z } from 'zod';
import type { RerankProvider } from './embedding-provider-types.js';
import { selectRetrievalSnippet } from './retrieval-text.js';

const responseSchema = z.object({ model: z.string(), revision: z.string(),
  results: z.array(z.object({ index: z.number().int().nonnegative(), score: z.number().finite() }).strict()).min(1),
}).strict();

export class LocalRerankProvider implements RerankProvider {
  readonly name = 'local-cross-encoder' as const;
  constructor(private readonly baseUrl: string, private readonly model: string, private readonly revision: string) {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('RAG_LOCAL_RERANK_LOOPBACK_REQUIRED');
    if (!model.trim() || !/^[a-f0-9]{40}$/.test(revision)) throw new Error('RAG_LOCAL_RERANK_IDENTITY_REQUIRED');
  }
  async rerank(query: string, candidates: Array<{ id: string; text: string; title?: string }>, topK: number, signal?: AbortSignal): Promise<string[]> {
    if (!candidates.length) return [];
    const result = await fetch(`${this.baseUrl.replace(/\/$/, '')}/rerank`, {
      method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
      body: JSON.stringify({ model: this.model, query,
        documents: candidates.map((candidate) => `${candidate.title ?? ''}\n${selectRetrievalSnippet(query, candidate.text)}`),
        top_n: Math.min(topK, candidates.length) }),
    });
    if (!result.ok) throw new Error(`RAG_LOCAL_RERANK_HTTP_${result.status}`);
    const parsed = responseSchema.parse(await result.json());
    if (parsed.model !== this.model || parsed.revision !== this.revision) throw new Error('RAG_LOCAL_RERANK_IDENTITY_MISMATCH');
    const indexes = parsed.results.map((row) => row.index);
    if (indexes.some((index) => index >= candidates.length) || new Set(indexes).size !== indexes.length) throw new Error('RAG_LOCAL_RERANK_INDEX_INVALID');
    return [...parsed.results].sort((a, b) => b.score - a.score || a.index - b.index).slice(0, topK).map((row) => candidates[row.index].id);
  }
  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/health`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
      const data = await response.json() as { ok?: boolean; model?: string; revision?: string };
      return { ok: response.ok && data.ok === true && data.model === this.model && data.revision === this.revision };
    } catch { return { ok: false, detail: 'local reranker unavailable' }; }
  }
}

export function createLocalRerankFromEnv(): LocalRerankProvider | undefined {
  if (process.env.SANGFOR_LOCAL_RERANK_ENABLED !== '1') return undefined;
  return new LocalRerankProvider(process.env.SANGFOR_LOCAL_RERANK_URL ?? 'http://127.0.0.1:8005',
    process.env.SANGFOR_LOCAL_RERANK_MODEL ?? '', process.env.SANGFOR_LOCAL_RERANK_REVISION ?? '');
}
