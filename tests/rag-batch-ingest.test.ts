import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  chunkText,
  extractTextFromFile,
  ingestDocumentsBatch,
  loadRagIndex,
  ragChunkContentHash
} from '../packages/sangfor-rag/src/index.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('RAG batch ingest', () => {
  it('writes multiple products in one index save and deduplicates reruns', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sangfor-rag-batch-'));
    roots.push(root);
    const hciPath = join(root, 'hci.md');
    const otherPath = join(root, 'ngfw.md');
    const indexPath = join(root, 'index.json');
    writeFileSync(hciPath, '# HCI\n\nConfigure storage MTU and verify every node.'.repeat(8));
    writeFileSync(otherPath, '# NGFW\n\nValidate the firewall policy and inspect the session table.'.repeat(8));

    const inputs = [
      { filePath: hciPath, product: 'HCI', indexPath, sourceType: 'manual' as const },
      { filePath: otherPath, product: 'OTHER', indexPath, sourceType: 'lesson' as const }
    ];
    const first = await ingestDocumentsBatch(inputs);
    const second = await ingestDocumentsBatch(inputs);
    const index = loadRagIndex(indexPath);

    expect(first.documentCount).toBe(2);
    expect(first.chunkCount).toBeGreaterThan(0);
    expect(second.chunkCount).toBe(0);
    expect(new Set(index.chunks.map((chunk) => chunk.product))).toEqual(new Set(['HCI', 'OTHER']));
    expect(new Set(index.chunks.map((chunk) => chunk.sourceType))).toEqual(new Set(['manual', 'lesson']));
  });

  it('stamps chunk identity so a re-embed pass can find the rows it must refresh', async () => {
    // scripts/rag-reembed.ts recomputes chunk identity from the file on disk to decide
    // whether it is refreshing an indexed row or adding a new one. If ingestion derives
    // that identity from different text than the re-embed pass does, every row looks new
    // and a "re-embed" silently doubles the index instead of updating it.
    const root = mkdtempSync(join(tmpdir(), 'sangfor-rag-identity-'));
    roots.push(root);
    const filePath = join(root, 'doc.md');
    const indexPath = join(root, 'index.json');
    writeFileSync(filePath, '# HCI\n\nConfigure storage MTU and verify every node.'.repeat(8));

    await ingestDocumentsBatch([{ filePath, product: 'HCI', indexPath, sourceType: 'manual' as const }]);
    const index = loadRagIndex(indexPath);

    const expected = chunkText(await extractTextFromFile(filePath))
      .map((text, i) => ragChunkContentHash(filePath, i, text));
    expect(expected.length).toBe(index.chunks.length);
    expect(index.chunks.map((chunk) => chunk.contentHash)).toEqual(expected);
  });
});
