import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ragSearch, ragSearchSync, resetEmbeddingProviderCache } from '../packages/sangfor-rag/src/index.js';
import { ragSearchScopedSync } from '../packages/sangfor-rag/src/rag-search.js';
import { createLocalRerankFromEnv, localRerankConfigurationDigest } from '../packages/sangfor-rag/src/local-rerank-provider.js';
const dirs: string[] = [];
const revision = 'a'.repeat(40);
const digest = localRerankConfigurationDigest('test-model', revision, { maxLength: 512, dtype: 'auto', batchSize: 16 });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); resetEmbeddingProviderCache(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup(count = 2) {
  vi.stubEnv('SANGFOR_EMBEDDING_FORCE_HASH', '1');
  vi.stubEnv('SANGFOR_LOCAL_RERANK_ENABLED', '1');
  vi.stubEnv('SANGFOR_MIMO_RERANK_ENABLED', '0');
  vi.stubEnv('SANGFOR_LOCAL_RERANK_MODEL', 'test-model');
  vi.stubEnv('SANGFOR_LOCAL_RERANK_REVISION', revision);
  vi.stubEnv('SANGFOR_LOCAL_RERANK_MIN_SCORE', '4');
  vi.stubEnv('SANGFOR_MIMO_RERANK_TIMEOUT_MS', '5000');
  const dir = mkdtempSync(join(tmpdir(), 'local-score-gate-')); dirs.push(dir);
  const indexPath = join(dir, 'index.json');
  writeFileSync(indexPath, JSON.stringify({ version: 1, updatedAt: new Date(0).toISOString(),
    chunks: Array.from({ length: count }, (_, i) => ({ id: `doc-${i}`, filePath: `${i}.md`, title: 'heartbeat',
      section: 'network', text: 'heartbeat procedure', product: 'HCI', sourceType: 'manual', trustLevel: 'official', contentHash: `${i}`, vector: [] })),
  }));
  return { query: 'heartbeat', product: 'HCI', limit: 5, indexPath };
}
function respond(results: unknown[], configurationSha256 = digest) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ model: 'test-model', revision, configurationSha256, results }))));
}
describe('opt-in local score floor', () => {
  it('does not refill rejected candidates and retains actual scores', async () => {
    const input = setup();
    respond([{ index: 0, score: 3.9 }, { index: 1, score: 4 }]);
    const hits = await ragSearch(input);
    expect(hits.map(h => h.id)).toEqual(['doc-1']);
    expect(hits[0].rerankScore).toBe(4);
  });
  it('scores even a single candidate and permits verified below-floor empty results', async () => {
    const input = setup(1); respond([{ index: 0, score: 3.9 }]);
    expect(await ragSearch(input)).toEqual([]);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([
    [{ index: 0, score: 8 }],
    [],
    [{ index: 0, score: 8 }, { index: 3, score: -1 }],
    [{ index: 0, score: 8 }, { index: 1, score: null }],
  ])('treats incomplete or malformed scores as unavailable, not abstention (%j)', async (...results) => {
    const input = setup(); respond(results);
    await expect(ragSearch(input)).rejects.toThrow('RAG_SCORE_GATE_UNAVAILABLE');
  });
  it('refuses a scorer configuration mismatch even if scores exceed the floor', async () => {
    const input = setup(); respond([{ index: 0, score: 8 }, { index: 1, score: 9 }], 'b'.repeat(64));
    await expect(ragSearch(input)).rejects.toThrow('RAG_SCORE_GATE_UNAVAILABLE');
  });
  it.each([503, 500])('does not use retrieval fallback on HTTP %i', async (status) => {
    const input = setup(); vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status })));
    await expect(ragSearch(input)).rejects.toThrow('RAG_SCORE_GATE_UNAVAILABLE');
  });
  it('aborts a timed-out request and reports unavailable', async () => {
    const input = setup(); vi.stubEnv('SANGFOR_MIMO_RERANK_TIMEOUT_MS', '10');
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      signal = init.signal as AbortSignal;
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    })));
    await expect(ragSearch(input)).rejects.toThrow('RAG_SCORE_GATE_UNAVAILABLE');
    expect(signal?.aborted).toBe(true);
  });
  it('refuses synchronous entry points instead of silently bypassing scoring', () => {
    const input = setup();
    expect(() => ragSearchSync(input)).toThrow('RAG_SCORE_GATE_ASYNC_REQUIRED');
    expect(() => ragSearchScopedSync({ ...input, chunks: [], authorization: { ok: false, reason: 'SCOPE_INVALID' } }))
      .toThrow('RAG_SCORE_GATE_ASYNC_REQUIRED');
  });
  it('refuses a configured floor with the scorer disabled', () => {
    setup(); vi.stubEnv('SANGFOR_LOCAL_RERANK_ENABLED', '0');
    expect(() => createLocalRerankFromEnv()).toThrow('RAG_LOCAL_RERANK_SCORE_GATE_REQUIRES_ENABLED_PROVIDER');
  });
  it.each(['', ' ', 'NaN', 'Infinity'])('rejects an invalid floor %j', value => {
    setup(); vi.stubEnv('SANGFOR_LOCAL_RERANK_MIN_SCORE', value);
    expect(() => createLocalRerankFromEnv()).toThrow('RAG_LOCAL_RERANK_MIN_SCORE_INVALID');
  });
});
