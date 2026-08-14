import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('rag:eval CLI', () => {
  it('emits a versioned metric artifact from qrels and run hits', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rag-eval-cli-'));
    try {
      const inputPath = join(dir, 'eval.json');
      writeFileSync(inputPath, JSON.stringify({
        k: 5,
        metadata: { corpusHash: 'fixture-corpus' },
        qrels: [{ queryId: 'q1', sourceId: 'doc-a', grade: 3 }],
        run: [{ queryId: 'q1', sourceId: 'doc-a', rank: 1, score: 0.99 }]
      }));

      const output = execFileSync('pnpm', ['tsx', 'scripts/rag-eval-run.ts', inputPath], {
        cwd: process.cwd(),
        encoding: 'utf8'
      });
      const artifact = JSON.parse(output) as {
        schemaVersion: number;
        k: number;
        metadata: { corpusHash?: string };
        metrics: { hitRateAtK: number; recallAtK: number };
      };

      expect(artifact.schemaVersion).toBe(1);
      expect(artifact.k).toBe(5);
      expect(artifact.metadata.corpusHash).toBe('fixture-corpus');
      expect(artifact.metrics.hitRateAtK).toBe(1);
      expect(artifact.metrics.recallAtK).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
