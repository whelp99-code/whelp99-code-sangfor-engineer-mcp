import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveEmbeddingSpace, type EmbeddingSpace } from '../packages/sangfor-rag/src/embedding-space.js';
import { resolveRagProduct } from '../packages/sangfor-rag/src/rag-product.js';
import { rankHybrid } from '../packages/sangfor-rag/src/rag-ranking.js';
import { getRagSearchDiagnostics, ragSearchSync, saveRagIndex, type RagDocumentChunk } from '@sangfor/rag';
import { embedForRole } from '../packages/sangfor-rag/src/embedding-provider.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const space = resolveEmbeddingSpace('model-a', 3, 'rapid-mlx', 'revision-a')!;
function chunk(id: string, patch: Partial<RagDocumentChunk> = {}): RagDocumentChunk {
  return {
    id, product: 'HCI', version: '6.1', sourceType: 'manual', trustLevel: 'official', title: id,
    text: 'storage MTU validation', filePath: `${id}.md`, contentHash: id,
    embeddingBackend: 'rapid-mlx', embeddingModel: 'model-a', embeddingSpace: space,
    vectorDims: 3, vector: [1, 0, 0], ...patch,
  };
}

describe('RAG embedding-space identity', () => {
  it('refuses unknown product filters instead of silently searching HCI', () => {
    expect(() => resolveRagProduct('unregistered-vendor')).toThrow('RAG_PRODUCT_UNKNOWN');
    expect(() => ragSearchSync({ query: 'storage', product: 'unregistered-vendor', indexPath: '/nonexistent/index.json' })).toThrow('RAG_PRODUCT_UNKNOWN');
    expect(resolveRagProduct('NGAF')).toBe('NGFW');
    expect(resolveRagProduct('Sangfor Cloud Platform')).toBe('HCI_SCP');
    expect(resolveRagProduct('OTHER')).toBe('OTHER');
  });
  it('does not compare equally sized vectors from another model', () => {
    const [hit] = rankHybrid([chunk('foreign', { embeddingModel: 'model-b' })], [1, 0, 0], 'storage', space);
    expect(hit).toMatchObject({ vectorScoreUsed: false, retrievalMode: 'bm25', cosineScore: 0 });
    expect(hit.keywordScore).toBeGreaterThan(0);
  });

  it.each([
    { revision: 'another-revision' }, { queryPrefix: 'query: ' }, { documentPrefix: 'passage: ' },
    { model: 'another-model' }, { dimensions: 2 },
  ] satisfies Partial<EmbeddingSpace>[])('refuses a changed embedding transformation %j', (change) => {
    const [hit] = rankHybrid([chunk('changed', { embeddingSpace: { ...space, ...change } })], [1, 0, 0], 'MTU', space);
    expect(hit.vectorScoreUsed).toBe(false);
    expect(hit.retrievalMode).toBe('bm25');
  });

  it('uses a verified semantic vector and never reconstructs a missing vector with hashes', () => {
    const hits = rankHybrid([chunk('match'), chunk('legacy', { embeddingSpace: undefined }),
      chunk('wrong-dimension', { vector: [1, 0] }), chunk('zero', { vector: [0, 0, 0] })], [1, 0, 0], 'MTU', space);
    expect(hits[0]).toMatchObject({ vectorScoreUsed: true, retrievalMode: 'hybrid-semantic', cosineScore: 1 });
    expect(hits.slice(1).every((hit) => !hit.vectorScoreUsed && hit.cosineScore === 0)).toBe(true);
  });

  it('never compares a hash query to semantic vectors', () => {
    const hashSpace = resolveEmbeddingSpace('hash', 3, 'hash');
    const [hit] = rankHybrid([chunk('semantic')], [1, 0, 0], 'MTU', hashSpace);
    expect(hit).toMatchObject({ vectorScoreUsed: false, retrievalMode: 'bm25' });
  });

  it('keeps legacy documents searchable while reporting BM25 and enforcing version and tenant filters', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rag-space-')); dirs.push(dir);
    const path = join(dir, 'index.json');
    saveRagIndex({ version: 2, updatedAt: new Date().toISOString(), chunks: [
      chunk('correct'), chunk('wrong-version', { version: '5.0' }), chunk('unknown-version', { version: undefined }),
      chunk('private', { tenantId: 'another-customer', projectId: 'private-project' }),
    ] }, path);
    const hits = ragSearchSync({ query: 'storage MTU', product: 'HCI', version: '6.1', indexPath: path });
    expect(hits.map((hit) => hit.id)).toEqual(['correct']);
    expect(hits[0].retrievalMode).toBe('bm25');
    expect(getRagSearchDiagnostics()).toMatchObject({ retrievalMode: 'bm25', incompatibleEmbeddingSpaces: 1 });
  });

  it('rejects incomplete embedding batches before a caller can mislabel a hash replacement', async () => {
    const provider = { name: 'rapid-mlx' as const, dimensions: 3,
      embed: async () => [[1, 0, 0]], healthCheck: async () => ({ ok: true }) };
    await expect(embedForRole(provider, ['first', 'second'], 'document')).rejects.toThrow('EMBEDDING_VECTOR_BATCH_INVALID');
  });
});
