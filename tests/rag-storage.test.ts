import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listShardedJsonlProducts, loadShardedJsonlIndex, recommendStorageMigration, saveShardedJsonlIndex } from '../packages/sangfor-rag/src/storage.js';
import type { RagIndex } from '../packages/sangfor-rag/src/index.js';

describe('recommendStorageMigration', () => {
  it('keeps small indexes on json and recommends migration after threshold', () => {
    expect(recommendStorageMigration(10_000, 10_000_000)).toBeNull();
    expect(recommendStorageMigration(66_657, 250_000_000)).toMatchObject({
      from: 'json-file',
      to: 'sqlite-vec',
      requiresFreshBuild: true
    });
  });

  it('round-trips a product-sharded JSONL index', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rag-shards-'));
    try {
      const index: RagIndex = {
        version: 2,
        updatedAt: new Date(0).toISOString(),
        chunks: [
          {
            id: 'a',
            sourceType: 'manual',
            product: 'HCI',
            title: 'A',
            text: 'alpha',
            trustLevel: 'official',
            vector: [1],
            contentHash: 'a',
            filePath: 'a.md'
          },
          {
            id: 'b',
            sourceType: 'manual',
            product: 'IAG',
            title: 'B',
            text: 'bravo',
            trustLevel: 'official',
            vector: [0],
            contentHash: 'b',
            filePath: 'b.md'
          }
        ]
      };

      const manifest = saveShardedJsonlIndex(index, dir);
      const loaded = loadShardedJsonlIndex(dir);

      expect(manifest.chunkCount).toBe(2);
      expect(listShardedJsonlProducts(dir)).toEqual(['HCI', 'IAG']);
      expect(loaded.chunks.map((chunk) => chunk.id).sort()).toEqual(['a', 'b']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
