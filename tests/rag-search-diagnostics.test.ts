import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getRagSearchDiagnostics,
  ragSearch,
  saveRagIndex,
  type RagIndex
} from '../packages/sangfor-rag/src/index.js';

const dirs: string[] = [];

afterEach(() => {
  delete process.env.SANGFOR_EMBEDDING_FORCE_HASH;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const mk = () => {
  const dir = mkdtempSync(join(tmpdir(), 'rag-diagnostics-'));
  dirs.push(dir);
  return dir;
};

describe('ragSearch diagnostics', () => {
  it('reports mixed model cohorts and query/index vector dimension mismatches', async () => {
    process.env.SANGFOR_EMBEDDING_FORCE_HASH = '1';
    const indexPath = join(mk(), 'index.json');
    const index: RagIndex = {
      version: 2,
      updatedAt: new Date(0).toISOString(),
      chunks: [
        {
          id: 'doc-a',
          sourceType: 'manual',
          product: 'HCI',
          title: 'A',
          section: 'A',
          text: 'storage heartbeat mtu',
          trustLevel: 'official',
          vector: [1, 0, 0],
          contentHash: 'a',
          filePath: 'a.md',
          embeddingBackend: 'rapid-mlx',
          embeddingModel: 'model-a',
          vectorDims: 3
        },
        {
          id: 'doc-b',
          sourceType: 'manual',
          product: 'HCI',
          title: 'B',
          section: 'B',
          text: 'storage heartbeat vlan',
          trustLevel: 'official',
          vector: Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0)),
          contentHash: 'b',
          filePath: 'b.md',
          embeddingBackend: 'rapid-mlx',
          embeddingModel: 'model-b',
          vectorDims: 384
        }
      ]
    };

    saveRagIndex(index, indexPath);
    await ragSearch({ product: 'HCI', query: 'storage heartbeat', indexPath, limit: 2 });

    const diagnostics = getRagSearchDiagnostics();
    expect(diagnostics.degraded).toBe(true);
    expect(diagnostics.queryBackend).toBe('hash');
    expect(diagnostics.queryVectorDims).toBe(384);
    expect(diagnostics.vectorDimensionMismatches).toBe(1);
    expect(diagnostics.mixedEmbeddingModels).toBe(true);
    expect(diagnostics.degradedReason).toMatch(/vector dimensions/);
    expect(diagnostics.degradedReason).toMatch(/mixed embedding model/);
  });
});
