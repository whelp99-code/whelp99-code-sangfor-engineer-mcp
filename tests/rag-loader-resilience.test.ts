import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestDocument, loadRagIndex, ragSearchSync, saveRagIndex, type RagIndex } from '../packages/sangfor-rag/src/index.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const mk = () => { const d = mkdtempSync(join(tmpdir(), 'rag-resilience-')); dirs.push(d); return d; };

describe('loadRagIndex — missing file stays a silent empty index (unchanged behavior)', () => {
  it('returns an empty index for a nonexistent path', () => {
    const dir = mk();
    const indexPath = join(dir, 'does-not-exist.json');
    const index = loadRagIndex(indexPath);
    expect(index.chunks).toEqual([]);
  });
});

describe('loadRagIndex — a corrupt (unparseable) index file must fail loud, not silently reset', () => {
  it('throws RAG_INDEX_CORRUPT naming the path, instead of returning an empty index', () => {
    const dir = mk();
    const indexPath = join(dir, 'index.json');
    writeFileSync(indexPath, '{ this is not valid json ');
    expect(() => loadRagIndex(indexPath)).toThrow(`RAG_INDEX_CORRUPT: ${indexPath}`);
  });
});

describe('loadRagIndex — mtime-based cache', () => {
  it('serves the same cached reference when the file has not changed', () => {
    const dir = mk();
    const indexPath = join(dir, 'index.json');
    const empty: RagIndex = { version: 1, chunks: [], updatedAt: new Date().toISOString() };
    saveRagIndex(empty, indexPath);

    const first = loadRagIndex(indexPath);
    const second = loadRagIndex(indexPath); // same mtime → same cached reference, no re-parse
    expect(second).toBe(first);
  });

  it('does not serve stale (empty) data after a write changes the file', async () => {
    const dir = mk();
    const indexPath = join(dir, 'index.json');
    saveRagIndex({ version: 1, chunks: [], updatedAt: new Date().toISOString() }, indexPath);
    expect(loadRagIndex(indexPath).chunks).toEqual([]); // prime the cache on the empty index

    const docPath = join(dir, 'doc.md');
    writeFileSync(docPath, '# Title\n\nSome storage network content for MTU validation.');
    process.env.SANGFOR_EMBEDDING_FORCE_HASH = '1';
    try {
      await ingestDocument({ filePath: docPath, product: 'HCI', indexPath });
    } finally {
      delete process.env.SANGFOR_EMBEDDING_FORCE_HASH;
    }
    const reloaded = loadRagIndex(indexPath);
    expect(reloaded.chunks.length).toBeGreaterThan(0);
  });
});

describe('ragSearchSync against a corrupt index', () => {
  it('propagates RAG_INDEX_CORRUPT rather than silently searching an empty index', () => {
    const dir = mk();
    const indexPath = join(dir, 'index.json');
    writeFileSync(indexPath, 'NOT JSON AT ALL');
    expect(() => ragSearchSync({ query: 'anything', indexPath })).toThrow('RAG_INDEX_CORRUPT');
  });
});
