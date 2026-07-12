import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { RagSearchHit } from '../packages/sangfor-rag/src/index.js';

const FIXTURE_HIT: RagSearchHit = {
  id: 'wiki_hci_mtu_lesson_001',
  sourceType: 'wiki',
  product: 'HCI',
  version: '6.8',
  title: 'HCI 3-Node Deployment Lessons',
  section: 'Storage Network MTU',
  text: 'Internal lesson: HCI 3-node deployment should include MTU consistency check.',
  trustLevel: 'internal',
  vector: [0.1, 0.2, 0.3],
  contentHash: 'abc123',
  filePath: 'data/wiki/seed/hci-mtu.md',
  embeddingBackend: 'hash',
  embeddingModel: 'hash-v1',
  vectorDims: 384,
  score: 0.87,
  rerankScore: 0.91
};

vi.mock('../packages/sangfor-rag/src/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../packages/sangfor-rag/src/index.js')>();
  return { ...actual, ragSearch: vi.fn(async () => [FIXTURE_HIT]) };
});

const { ragSearch } = await import('../packages/sangfor-rag/src/index.js');
const { postRagSearch, toPublicHit } = await import('../apps/operator-console/src/api.js');
const { createOperatorServer } = await import('../apps/operator-console/src/server.js');

async function withServer(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createOperatorServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('toPublicHit', () => {
  it('exposes only consumer-facing fields, dropping vector and other internal fields', () => {
    const pub = toPublicHit(FIXTURE_HIT);
    expect(pub).toEqual({
      id: FIXTURE_HIT.id,
      product: FIXTURE_HIT.product,
      version: FIXTURE_HIT.version,
      title: FIXTURE_HIT.title,
      section: FIXTURE_HIT.section,
      text: FIXTURE_HIT.text,
      trustLevel: FIXTURE_HIT.trustLevel,
      score: FIXTURE_HIT.score,
      rerankScore: FIXTURE_HIT.rerankScore,
      source: FIXTURE_HIT.filePath
    });
    expect(pub).not.toHaveProperty('vector');
    expect(pub).not.toHaveProperty('contentHash');
    expect(pub).not.toHaveProperty('embeddingBackend');
    expect(pub).not.toHaveProperty('embeddingModel');
    expect(pub).not.toHaveProperty('vectorDims');
  });
});

describe('postRagSearch', () => {
  it('wraps ragSearch hits in a {query, results} envelope', async () => {
    const response = await postRagSearch({ query: 'MTU storage', product: 'HCI' });
    expect(Array.isArray(response)).toBe(false);
    expect(response).toEqual({ query: 'MTU storage', results: [toPublicHit(FIXTURE_HIT)] });
  });
});

describe('POST /api/rag-search', () => {
  afterEach(() => {
    vi.mocked(ragSearch).mockClear();
  });

  it('returns the {query, results} envelope with vectors stripped for a valid query', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/rag-search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'MTU storage' })
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(false);
      expect(body.query).toBe('MTU storage');
      expect(Array.isArray(body.results)).toBe(true);
      expect(body.results[0]).not.toHaveProperty('vector');
    });
  });

  it('returns 400 and never calls ragSearch when query is missing', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/rag-search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({})
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBeTruthy();
      expect(ragSearch).not.toHaveBeenCalled();
    });
  });

  it('returns 400 for a whitespace-only query', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/rag-search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: '   ' })
      });
      expect(res.status).toBe(400);
      expect(ragSearch).not.toHaveBeenCalled();
    });
  });
});
