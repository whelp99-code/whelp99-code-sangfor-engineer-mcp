import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestDocument, loadRagIndex } from '../packages/sangfor-rag/src/index.js';

const dirs: string[] = [];
afterEach(() => {
  delete process.env.SANGFOR_EMBEDDING_FORCE_HASH;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const mk = () => { const d = mkdtempSync(join(tmpdir(), 'rag-ingest-concurrency-')); dirs.push(d); return d; };

describe('ingestDocument — shares saveRagIndex\'s lock across its whole load-modify-save (G2)', () => {
  it('actually acquires the index lock: a pre-held lock blocks ingestDocument, then it succeeds once released', async () => {
    const dir = mk();
    const indexPath = join(dir, 'index.json');
    const lockPath = `${indexPath}.lock`;
    process.env.SANGFOR_EMBEDDING_FORCE_HASH = '1';

    const docPath = join(dir, 'a.md');
    writeFileSync(docPath, '# Doc A\n\nStorage network MTU validation content.');

    mkdirSync(lockPath); // simulate a concurrent writer (another process) holding the index lock
    try {
      await expect(ingestDocument({ filePath: docPath, product: 'HCI', indexPath, title: 'Doc A' }))
        .rejects.toThrow(/LOCK_TIMEOUT/);
      // Blocked attempt must not have written anything.
      expect(loadRagIndex(indexPath).chunks).toEqual([]);
    } finally {
      rmdirSync(lockPath);
    }

    const result = await ingestDocument({ filePath: docPath, product: 'HCI', indexPath, title: 'Doc A' });
    expect(result.chunkCount).toBeGreaterThan(0);
  }, 10_000);

  it('two sequential ingests into the same index both land — both documents\' chunks are present afterward', async () => {
    const dir = mk();
    const indexPath = join(dir, 'index.json');
    process.env.SANGFOR_EMBEDDING_FORCE_HASH = '1';

    const docAPath = join(dir, 'a.md');
    writeFileSync(docAPath, '# Doc A\n\nStorage network MTU validation content for cluster A.');
    const docBPath = join(dir, 'b.md');
    writeFileSync(docBPath, '# Doc B\n\nEndpoint agent deployment pilot rollout content for cluster B.');

    const resultA = await ingestDocument({ filePath: docAPath, product: 'HCI', indexPath, title: 'Doc A' });
    const resultB = await ingestDocument({ filePath: docBPath, product: 'ENDPOINT_SECURE', indexPath, title: 'Doc B' });

    expect(resultA.chunkCount).toBeGreaterThan(0);
    expect(resultB.chunkCount).toBeGreaterThan(0);

    const index = loadRagIndex(indexPath);
    const titles = new Set(index.chunks.map((c) => c.title));
    expect(titles.has('Doc A')).toBe(true);
    expect(titles.has('Doc B')).toBe(true);
    expect(index.chunks.length).toBe(resultA.chunkCount + resultB.chunkCount);
  });

  it('concurrent (Promise.all) ingests of distinct documents against the same index all land without loss', async () => {
    // Node is single-threaded, so this cannot by itself prove the lock is
    // load-bearing (see the lock-engagement test above for that) — it is a
    // correctness/regression check that the lock-wrapped path still behaves
    // right under interleaved async calls, matching the literal ask of
    // ingesting into the same index repeatedly and finding every document's
    // chunks present afterward.
    const dir = mk();
    const indexPath = join(dir, 'index.json');
    process.env.SANGFOR_EMBEDDING_FORCE_HASH = '1';

    const docs = Array.from({ length: 10 }, (_, i) => {
      const p = join(dir, `doc-${i}.md`);
      writeFileSync(p, `# Doc ${i}\n\nUnique content marker doc-${i}-unique-token about storage or policy topic ${i}.`);
      return { filePath: p, title: `Doc ${i}` };
    });

    const results = await Promise.all(
      docs.map((d) => ingestDocument({ filePath: d.filePath, product: 'HCI', indexPath, title: d.title })),
    );
    const expectedTotal = results.reduce((sum, r) => sum + r.chunkCount, 0);

    const index = loadRagIndex(indexPath);
    expect(index.chunks.length).toBe(expectedTotal);
    const titles = new Set(index.chunks.map((c) => c.title));
    for (const d of docs) expect(titles.has(d.title)).toBe(true);
  });
});
