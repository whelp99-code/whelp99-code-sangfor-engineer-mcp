import { expandRerankPassages } from '../packages/sangfor-rag/src/rag-ranking.js';
import type { RagDocumentChunk } from '../packages/sangfor-rag/src/rag-types.js';
import { tokenize } from '../packages/sangfor-rag/src/bm25.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchOpenAIEmbeddings } from '../packages/sangfor-rag/src/openai-embeddings-client.js';
import { LocalRerankProvider, createLocalRerankFromEnv } from '../packages/sangfor-rag/src/local-rerank-provider.js';

const revision = 'a'.repeat(40);
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const embeddings = (data: unknown) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(data))));
const options = { baseUrl: 'http://127.0.0.1:8004/v1', model: 'expected', revision };

describe('embedding identity and response integrity', () => {
  it('accepts a matching pinned model and orders response rows by their explicit input index', async () => {
    embeddings({ model: 'expected', revision, data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] });
    expect((await fetchOpenAIEmbeddings(['a', 'b'], options)).vectors).toEqual([[1, 0], [0, 1]]);
  });
  it.each([
    { model: 'different', revision }, { model: 'expected', revision: 'b'.repeat(40) }, { model: 'expected' }, {},
  ])('refuses mismatched or unverifiable pinned identity %j', async (identity) => {
    embeddings({ ...identity, data: [{ index: 0, embedding: [1, 0] }] });
    await expect(fetchOpenAIEmbeddings(['a'], options)).rejects.toThrow(/EMBEDDING_(MODEL|REVISION)_MISMATCH/);
  });
  it.each([
    [{ index: 0, embedding: [1, 0] }, { index: 0, embedding: [0, 1] }],
    [{ index: 1, embedding: [1, 0] }, { index: 2, embedding: [0, 1] }],
    [{ index: 0, embedding: [] }, { index: 1, embedding: [] }],
    [{ index: 0, embedding: [1, 0] }, { index: 1, embedding: [1] }],
    [{ index: 0, embedding: [null, 0] }, { index: 1, embedding: [0, 1] }],
  ].map((rows) => [rows]))('refuses malformed vector correspondence %#', async (rows) => {
    embeddings({ model: 'expected', revision, data: rows });
    await expect(fetchOpenAIEmbeddings(['a', 'b'], options)).rejects.toThrow('EMBEDDING_RESPONSE_INVALID');
  });
});

describe('local reranker boundary', () => {
  const candidates = [{ id: 'a', title: 'Storage', text: 'quorum' }, { id: 'b', text: 'heartbeat' }];
  it.each(['https://127.0.0.1:8005', 'http://example.com', 'http://127.0.0.1.evil.test', 'http://user:pass@127.0.0.1:8005', 'http://127.0.0.1:8005/path'])('refuses nonlocal or ambiguous target %s', (url) => {
    expect(() => new LocalRerankProvider(url, 'expected', revision)).toThrow();
  });
  it('is disabled until explicitly configured', () => {
    vi.stubEnv('SANGFOR_LOCAL_RERANK_ENABLED', '0'); expect(createLocalRerankFromEnv()).toBeUndefined();
  });
  it('checks identity, returns known IDs in score order, and refuses redirects', async () => {
    embeddings({ model: 'expected', revision, results: [{ index: 0, score: 0.1 }, { index: 1, score: 0.9 }] });
    const provider = new LocalRerankProvider('http://127.0.0.1:8005', 'expected', revision);
    expect(await provider.rerank('heartbeat', candidates, 2)).toEqual(['b', 'a']);
    expect(vi.mocked(fetch).mock.calls[0][1]?.redirect).toBe('error');
  });
  it('does not spend the reranker input on a duplicated full breadcrumb heading', async () => {
    embeddings({ model: 'expected', revision, results: [{ index: 0, score: 1.25 }] });
    const provider = new LocalRerankProvider('http://127.0.0.1:8005', 'expected', revision);
    await provider.rerankScored('certificate import', [{
      id: 'a', title: 'HCI 6.11.3 / Certificate settings',
      text: '# HCI 6.11.3 / Certificate settings\n\nOnly CRT files are supported.',
    }], 1);
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string);
    expect(body.documents).toEqual(['HCI 6.11.3 / Certificate settings\nOnly CRT files are supported.']);
  });
  it('retains raw negative and fractional scores instead of replacing them with ranks or probabilities', async () => {
    embeddings({ model: 'expected', revision, results: [{ index: 0, score: -3.25 }, { index: 1, score: 7.625 }] });
    const provider = new LocalRerankProvider('http://127.0.0.1:8005', 'expected', revision);
    expect(await provider.rerankScored('heartbeat', candidates, 2)).toEqual([
      { id: 'b', score: 7.625 }, { id: 'a', score: -3.25 },
    ]);
  });
  it.each([
    { model: 'different', revision, results: [{ index: 0, score: 1 }] },
    { model: 'expected', revision: 'b'.repeat(40), results: [{ index: 0, score: 1 }] },
    { model: 'expected', revision, results: [{ index: 4, score: 1 }] },
    { model: 'expected', revision, results: [{ index: 0, score: 1 }, { index: 0, score: 2 }] },
    { model: 'expected', revision, results: [] },
    { model: 'expected', revision, results: [{ index: 0, score: null }] },
  ])('refuses malformed or foreign results %#', async (response) => {
    embeddings(response);
    const provider = new LocalRerankProvider('http://127.0.0.1:8005', 'expected', revision);
    await expect(provider.rerank('query', candidates, 2)).rejects.toThrow();
    await expect(provider.rerankScored('query', candidates, 2)).rejects.toThrow();
  });
});

it('normalizes technical noun inflections without stemming command paths or status words', () => {
  expect(tokenize('routes restrictions snapshots policies')).toEqual(['route', 'restriction', 'snapshot', 'policy']);
  expect(tokenize('/api/routes eth0.routes status chassis analysis')).toEqual(['/api/routes', 'eth0.routes', 'status', 'chassis', 'analysis']);
});

it('retains every candidate source while adding a distinct second passage within the hard cap', () => {
  const hit = (id: string, filePath: string): RagDocumentChunk => ({ id, filePath, title: id,
    text: id, product: 'HCI', sourceType: 'manual', trustLevel: 'official', vector: [], contentHash: id });
  const first = hit('a1', 'a.md'), second = hit('b1', 'b.md');
  const pool = expandRerankPassages([first, hit('a2', 'a.md'), hit('a3', 'a.md'), second, hit('b2', 'b.md')], [first, second]);
  expect(pool.map((row) => row.id)).toEqual(['a1', 'b1', 'a2', 'b2']);
  const seeds = Array.from({ length: 100 }, (_, i) => hit(`${i}`, `${i}.md`));
  expect(expandRerankPassages([...seeds, hit('extra', '0.md')], seeds)).toHaveLength(100);
});

it('does not turn a negative or missing health assertion into success', async () => {
  const provider = new LocalRerankProvider('http://127.0.0.1:8005', 'expected', revision);
  for (const ok of [false, undefined]) {
    embeddings({ ok, model: 'expected', revision });
    expect((await provider.healthCheck()).ok).toBe(false);
  }
  embeddings({ ok: true, model: 'expected', revision });
  expect((await provider.healthCheck()).ok).toBe(true);
});
