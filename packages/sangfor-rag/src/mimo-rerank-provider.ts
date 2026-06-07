import type { RerankProvider } from './embedding-provider-types.js';
import { resolveMimoBaseUrl, resolveMimoBillingMode } from './mimo-config.js';

export class MimoRerankProvider implements RerankProvider {
  readonly name = 'mimo' as const;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
    private readonly timeoutMs = 60_000,
    private readonly maxSnippetChars = 400
  ) {}

  async rerank(
    query: string,
    candidates: Array<{ id: string; text: string; title?: string }>,
    topK: number
  ): Promise<string[]> {
    if (!candidates.length) return [];
    const lines = candidates.map((c, i) => {
      const snippet = c.text.replace(/\s+/g, ' ').trim().slice(0, this.maxSnippetChars);
      const title = c.title ?? '';
      return `${i}|${c.id}|${title}|${snippet}`;
    });
    const prompt = [
      'Score each Sangfor engineering document snippet for relevance to the query.',
      'Return JSON only: {"ranked":["id1","id2",...]} with ids sorted best-first.',
      `Query: ${query}`,
      'Candidates (index|id|title|snippet):',
      ...lines
    ].join('\n');

    const url = `${this.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'api-key': this.apiKey
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: 'You rank technical documentation snippets. Respond with valid JSON only.' },
            { role: 'user', content: prompt }
          ],
          max_completion_tokens: 1024,
          temperature: 0.1,
          stream: false
        }),
        signal: controller.signal
      });
      if (!res.ok) {
        throw new Error(`MiMo rerank ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
      const content = data.choices?.[0]?.message?.content ?? '';
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('MiMo rerank: no JSON in response');
      const parsed = JSON.parse(jsonMatch[0]) as { ranked?: string[] };
      const ranked = parsed.ranked?.filter(id => candidates.some(c => c.id === id)) ?? [];
      if (ranked.length) return ranked.slice(0, topK);
    } finally {
      clearTimeout(timeout);
    }
    return candidates.slice(0, topK).map(c => c.id);
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const url = `${this.baseUrl.replace(/\/$/, '')}/chat/completions`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'api-key': this.apiKey },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: 'ping' }],
          max_completion_tokens: 8
        })
      });
      return { ok: res.ok, detail: res.ok ? this.model : await res.text().then(t => t.slice(0, 120)) };
    } catch (err) {
      return { ok: false, detail: String(err) };
    }
  }
}

export function createMimoRerankFromEnv(): RerankProvider | undefined {
  if (process.env.SANGFOR_MIMO_RERANK_ENABLED === '0') return undefined;
  if (process.env.SANGFOR_ALLOW_CLOUD_RAG !== '1') return undefined;
  const apiKey = process.env.SANGFOR_MIMO_API_KEY?.trim();
  if (!apiKey) return undefined;
  return new MimoRerankProvider(
    resolveMimoBaseUrl(),
    apiKey,
    process.env.SANGFOR_MIMO_CHAT_MODEL ?? 'mimo-v2.5-pro',
    Number(process.env.SANGFOR_MIMO_TIMEOUT_MS ?? 60_000)
  );
}

export { resolveMimoBaseUrl, resolveMimoBillingMode } from './mimo-config.js';
