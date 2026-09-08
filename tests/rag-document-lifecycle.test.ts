import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ingestDocument, ingestDocumentsBatch, loadRagIndex, ragSearchSync, removeRagDocument } from '@sangfor/rag';

const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  vi.stubEnv('SANGFOR_EMBEDDING_FORCE_HASH', '1');
  const dir = mkdtempSync(join(tmpdir(), 'rag-lifecycle-')); dirs.push(dir);
  return { filePath: join(dir, 'manual.md'), indexPath: join(dir, 'index.json'), product: 'HCI', version: '6.1' };
}

describe('derived RAG document revisions', () => {
  it('replaces a changed document and removes obsolete chunks from cached and persisted results', async () => {
    const input = fixture();
    writeFileSync(input.filePath, 'obsolete value MTU 1500 '.repeat(100));
    await ingestDocument(input);
    expect(loadRagIndex(input.indexPath).chunks.length).toBeGreaterThan(1);
    writeFileSync(input.filePath, 'new procedure MTU 9000');
    await ingestDocument(input);
    const hits = ragSearchSync({ query: 'MTU', indexPath: input.indexPath });
    expect(hits).toHaveLength(1);
    expect(hits[0].text).toContain('9000');
    expect(readFileSync(input.indexPath, 'utf8')).not.toContain('1500');
  });

  it('replaces metadata on batch reingestion without duplicating the old product/version', async () => {
    const input = fixture(); writeFileSync(input.filePath, 'version specific manual');
    await ingestDocumentsBatch([{ ...input, product: 'OTHER', version: undefined }]);
    await ingestDocumentsBatch([input]);
    expect(loadRagIndex(input.indexPath).chunks).toHaveLength(1);
    expect(loadRagIndex(input.indexPath).chunks[0]).toMatchObject({ product: 'HCI', version: '6.1' });
    expect((await ingestDocumentsBatch([input])).chunkCount).toBe(0);
  });

  it('removes search results without deleting the original, and refuses a superseded local writer', async () => {
    const input = fixture(); writeFileSync(input.filePath, 'MTU guide'); await ingestDocument(input);
    expect(removeRagDocument(input.filePath, input.indexPath).removedChunks).toBe(1);
    expect(ragSearchSync({ query: 'MTU', indexPath: input.indexPath })).toEqual([]);
    expect(readFileSync(input.filePath, 'utf8')).toBe('MTU guide');
    expect(removeRagDocument(input.filePath, input.indexPath).removedChunks).toBe(0);
    vi.stubEnv('SANGFOR_BLRO_AUTHORITY_STORE', 'postgres');
    expect(() => removeRagDocument(input.filePath, input.indexPath)).toThrow('JM_LOCAL_RAG_INDEX_SUPERSEDED');
  });
});
