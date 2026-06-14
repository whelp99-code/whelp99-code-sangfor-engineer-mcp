import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HashEmbeddingProvider } from '../packages/sangfor-rag/src/hash-embedding.js';
import { MimoRerankProvider } from '../packages/sangfor-rag/src/mimo-rerank-provider.js';
import { ingestDocument, ragSearchSync, exportRagIndexSummary } from '../packages/sangfor-rag/src/index.js';

describe('RAG embedding providers', () => {
  it('HashEmbeddingProvider is deterministic', async () => {
    const p = new HashEmbeddingProvider();
    const [a, b] = await p.embed(['HCI storage MTU', 'HCI storage MTU']);
    expect(a).toEqual(b);
    expect(a.length).toBe(384);
  });

  it('ingest and ragSearchSync find matching chunk', async () => {
    process.env.SANGFOR_EMBEDDING_FORCE_HASH = '1';
    const dir = mkdtempSync(join(tmpdir(), 'rag-emb-'));
    const docPath = join(dir, 'hci.md');
    const indexPath = join(dir, 'index.json');
    writeFileSync(docPath, '# HCI\n\nStorage network MTU validation before cluster init.');
    const result = await ingestDocument({ filePath: docPath, product: 'HCI', indexPath });
    expect(result.chunkCount).toBeGreaterThan(0);
    expect(result.embeddingBackend).toBe('hash');
    const hits = ragSearchSync({ product: 'HCI', query: 'MTU storage', indexPath });
    expect(hits[0]?.text.toLowerCase()).toContain('mtu');
    const summary = exportRagIndexSummary(indexPath);
    expect(summary.embeddingBackendCounts).toBeDefined();
    delete process.env.SANGFOR_EMBEDDING_FORCE_HASH;
  });

  it('MimoRerankProvider parses ranked ids from chat JSON', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"ranked":["b","a"]}' } }]
      })
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const reranker = new MimoRerankProvider('https://api.xiaomimimo.com/v1', 'test-key', 'mimo-v2.5-pro');
      const ranked = await reranker.rerank('HCI MTU', [
        { id: 'a', text: 'storage network MTU', title: 'HCI storage' },
        { id: 'b', text: 'VM migration checklist', title: 'Migration' }
      ], 2);
      expect(ranked).toEqual(['b', 'a']);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

const runEmbeddingIt = process.env.SANGFOR_RUN_EMBEDDING_IT === '1';

describe.runIf(runEmbeddingIt)('RAG golden retrieval (integration)', () => {
  it('HCI storage query returns storage-related chunk', async () => {
    process.env.SANGFOR_EMBEDDING_FORCE_HASH = '1';
    const dir = mkdtempSync(join(tmpdir(), 'rag-golden-'));
    const indexPath = join(dir, 'index.json');
    const hci = join(dir, 'hci.md');
    const epp = join(dir, 'epp.md');
    writeFileSync(hci, '# HCI\n\nValidate storage network MTU before cluster initialization.');
    writeFileSync(epp, '# EPP\n\nDeploy endpoint agent to pilot group after policy baseline.');
    await ingestDocument({ filePath: hci, product: 'HCI', indexPath });
    await ingestDocument({ filePath: epp, product: 'ENDPOINT_SECURE', indexPath });
    const hciHits = ragSearchSync({ product: 'HCI', query: 'storage MTU validation', indexPath, limit: 3 });
    const eppHits = ragSearchSync({ product: 'ENDPOINT_SECURE', query: 'agent pilot deployment', indexPath, limit: 3 });
    expect(hciHits[0]?.text.toLowerCase()).toMatch(/mtu|storage/);
    expect(eppHits[0]?.text.toLowerCase()).toMatch(/agent|pilot/);
    delete process.env.SANGFOR_EMBEDDING_FORCE_HASH;
  });
});
