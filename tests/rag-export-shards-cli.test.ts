import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveRagIndex, type RagIndex } from '../packages/sangfor-rag/src/index.js';

describe('rag:export-shards CLI', () => {
  it('exports a non-destructive sharded copy and reports a manifest artifact', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rag-export-shards-'));
    try {
      const indexPath = join(dir, 'index.json');
      const outputDir = join(dir, 'shards');
      const index: RagIndex = {
        version: 2,
        updatedAt: new Date(0).toISOString(),
        chunks: [{
          id: 'hci-a',
          sourceType: 'manual',
          product: 'HCI',
          title: 'HCI A',
          text: 'storage heartbeat',
          trustLevel: 'official',
          vector: [1],
          contentHash: 'hash-a',
          filePath: 'hci-a.md'
        }]
      };
      saveRagIndex(index, indexPath);

      const output = execFileSync('pnpm', ['tsx', 'scripts/rag-export-shards.ts', indexPath, outputDir], {
        cwd: process.cwd(),
        encoding: 'utf8'
      });
      const artifact = JSON.parse(output) as {
        action: string;
        manifest: { chunkCount: number; shards: Array<{ file: string }> };
      };

      expect(artifact.action).toBe('rag-export-shards');
      expect(artifact.manifest.chunkCount).toBe(1);
      expect(existsSync(join(outputDir, 'manifest.json'))).toBe(true);
      expect(existsSync(join(outputDir, artifact.manifest.shards[0].file))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
