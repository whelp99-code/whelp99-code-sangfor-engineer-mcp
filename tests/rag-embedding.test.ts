import { describe, expect, it } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HashEmbeddingProvider } from '../packages/sangfor-rag/src/hash-embedding.js';
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
});
