import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalRerankProvider, createLocalRerankFromEnv, localRerankConfigurationDigest } from '../packages/sangfor-rag/src/local-rerank-provider.js';
const revision = 'a'.repeat(40);
const configuration = { maxLength: 1024, dtype: 'float32' as const, batchSize: 4, instruction: '근거 확인\nOnly supported claims.' };
const digest = '454fe1c9462e191dbfcc6993c23ad68116b50286057969f58d471fdd0af85284';
const candidates = [{ id: 'source-a', text: 'document body' }];
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function respond(configurationSha256?: string) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    ok: true, model: 'expected', revision, configurationSha256,
  }))));
}
describe('local reranker configuration identity', () => {
  it('matches the Python service digest including UTF-8 and newlines', () => {
    expect(localRerankConfigurationDigest('expected', revision, configuration)).toBe(digest);
    expect(localRerankConfigurationDigest('expected', revision, { ...configuration, maxLength: 512 })).not.toBe(digest);
    expect(localRerankConfigurationDigest('expected', revision, { ...configuration, instruction: 'different' })).not.toBe(digest);
  });
  it.each([undefined, 'b'.repeat(64)])('refuses missing or changed scoring configuration %s', async (configurationSha256) => {
    const provider = new LocalRerankProvider('http://127.0.0.1:8005', 'expected', revision, configuration);
    respond(configurationSha256);
    expect((await provider.healthCheck()).ok).toBe(false);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      model: 'expected', revision, configurationSha256, results: [{ index: 0, score: 7 }],
    }))));
    await expect(provider.rerankScored('question', candidates, 1)).rejects.toThrow('RAG_LOCAL_RERANK_CONFIGURATION_MISMATCH');
  });
  it('accepts actual raw scores only after configuration identity matches', async () => {
    const provider = new LocalRerankProvider('http://127.0.0.1:8005', 'expected', revision, configuration);
    respond(digest);
    expect((await provider.healthCheck()).ok).toBe(true);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      model: 'expected', revision, configurationSha256: digest, results: [{ index: 0, score: -1.125 }],
    }))));
    expect(await provider.rerankScored('question', candidates, 1)).toEqual([{ id: 'source-a', score: -1.125 }]);
  });
  it.each([
    { maxLength: 0 }, { maxLength: 4097 }, { batchSize: 0 }, { batchSize: 33 },
    { maxLength: 4096, batchSize: 8 }, { instruction: '' }, { instruction: ' '.repeat(5) },
  ])('refuses invalid or unbounded configurations %j', (override) => {
    expect(() => new LocalRerankProvider('http://127.0.0.1:8005', 'expected', revision, { ...configuration, ...override })).toThrow();
  });
  it('pins the default service configuration even when no custom options are set', async () => {
    vi.stubEnv('SANGFOR_LOCAL_RERANK_ENABLED', '1');
    vi.stubEnv('SANGFOR_LOCAL_RERANK_MODEL', 'expected');
    vi.stubEnv('SANGFOR_LOCAL_RERANK_REVISION', revision);
    const provider = createLocalRerankFromEnv()!;
    respond();
    expect((await provider.healthCheck()).ok).toBe(false);
    respond(localRerankConfigurationDigest('expected', revision, { maxLength: 512, dtype: 'auto', batchSize: 16 }));
    expect((await provider.healthCheck()).ok).toBe(true);
  });
  it('rejects unsupported environment dtype instead of silently using the default', () => {
    vi.stubEnv('SANGFOR_LOCAL_RERANK_ENABLED', '1');
    vi.stubEnv('SANGFOR_LOCAL_RERANK_MODEL', 'expected');
    vi.stubEnv('SANGFOR_LOCAL_RERANK_REVISION', revision);
    vi.stubEnv('SANGFOR_LOCAL_RERANK_DTYPE', 'half');
    expect(() => createLocalRerankFromEnv()).toThrow();
  });
});
