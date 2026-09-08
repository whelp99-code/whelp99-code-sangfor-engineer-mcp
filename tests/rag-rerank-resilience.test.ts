import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ragSearch, getRagSearchDiagnostics, resetEmbeddingProviderCache } from '../packages/sangfor-rag/src/index.js';
import { MimoRerankProvider } from '../packages/sangfor-rag/src/mimo-rerank-provider.js';
import { rankHybrid } from '../packages/sangfor-rag/src/rag-ranking.js';
import { resolveEmbeddingSpace } from '../packages/sangfor-rag/src/embedding-space.js';
const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); resetEmbeddingProviderCache(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  vi.stubEnv('SANGFOR_EMBEDDING_FORCE_HASH', '1'); vi.stubEnv('SANGFOR_ALLOW_CLOUD_RAG', '1');
  vi.stubEnv('SANGFOR_MIMO_API_KEY', 'test'); vi.stubEnv('SANGFOR_MIMO_RERANK_ENABLED', '1');
  vi.stubEnv('SANGFOR_MIMO_VIA_LITELLM', '0');
  const dir = mkdtempSync(join(tmpdir(), 'rerank-resilience-')); dirs.push(dir);
  const chunks = Array.from({ length: 45 }, (_, i) => ({ id: `doc-${i}`, sourceType: 'manual' as const,
    product: 'HCI' as const, title: 'heartbeat', section: 'network', text: 'heartbeat configuration',
    trustLevel: 'official' as const, vector: [], contentHash: `${i}`, filePath: `${i}.md` }));
  const path = join(dir, 'index.json'); writeFileSync(path, JSON.stringify({ version: 1, updatedAt: new Date(0).toISOString(), chunks }));
  return { path, chunks };
}
describe('rerank fallback and mixed cohorts', () => {
  it.each(['0', 'NaN', '-1', '1'])('bounds candidate setting %s and fills partial output in original order', async (setting) => {
    const { path } = fixture(); vi.stubEnv('SANGFOR_MIMO_RERANK_CANDIDATES', setting);
    const rerank = vi.spyOn(MimoRerankProvider.prototype, 'rerank').mockResolvedValue(['doc-2']);
    const hits = await ragSearch({ query: 'heartbeat', product: 'HCI', limit: 3, indexPath: path });
    expect(hits.map((hit) => hit.id)).toEqual(['doc-2', 'doc-0', 'doc-1']);
    expect(rerank.mock.calls[0][1].length).toBeGreaterThanOrEqual(3);
    expect(rerank.mock.calls[0][1].length).toBeLessThanOrEqual(40);
    expect(getRagSearchDiagnostics(hits).degraded).toBe(true);
  });
  it('aborts the actual outstanding fetch when the search deadline expires', async () => {
    const { path } = fixture(); vi.stubEnv('SANGFOR_MIMO_RERANK_TIMEOUT_MS', '10');
    let observedSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      observedSignal = init.signal as AbortSignal;
      observedSignal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    })));
    const hits = await ragSearch({ query: 'heartbeat', product: 'HCI', limit: 3, indexPath: path });
    expect(hits).toHaveLength(3); expect(observedSignal?.aborted).toBe(true);
    expect(getRagSearchDiagnostics(hits).degraded).toBe(true);
  });
  it.each([[], ['unknown'], ['doc-1', 'doc-1']].map((ranked) => [ranked]))('retains lexical order and reports malformed rerank IDs %j', async (ranked) => {
    const { path } = fixture();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ranked }) } }] }))));
    const hits = await ragSearch({ query: 'heartbeat', product: 'HCI', limit: 3, indexPath: path });
    expect(hits.map((hit) => hit.id)).toEqual(['doc-0', 'doc-1', 'doc-2']);
    expect(hits.every((hit) => hit.rerankScore === undefined)).toBe(true);
    expect(getRagSearchDiagnostics(hits).degraded).toBe(true);
  });
  it('does not discount a lexical-only exact hit when another chunk has a verified vector', () => {
    const { chunks } = fixture();
    const space = resolveEmbeddingSpace('verified', 2, 'rapid-mlx', 'rev-a')!;
    const ranked = rankHybrid([{ ...chunks[0], text: 'heartbeat heartbeat' }, { ...chunks[1], title: 'other', text: 'other',
      vector: [1, 0], embeddingBackend: 'rapid-mlx' as const, embeddingModel: 'verified', vectorDims: 2, embeddingSpace: space }], [1, 0], 'heartbeat', space);
    expect(ranked[0].retrievalMode).toBe('bm25'); expect(ranked[0].score).toBe(1);
  });
});
