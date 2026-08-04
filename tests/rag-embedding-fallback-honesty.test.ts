import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getEmbeddingProvider, resetEmbeddingProviderCache, wasEmbeddingFallback, ingestDocument, exportRagIndexSummary } from '../packages/sangfor-rag/src/index.js';

const ENV_KEYS = [
  'SANGFOR_EMBEDDING_FORCE_HASH',
  'SANGFOR_EMBEDDING_PROVIDER',
  'SANGFOR_RAPID_MLX_BASE_URL',
  'SANGFOR_EMBEDDING_INIT_TIMEOUT_MS',
] as const;
const savedEnv = new Map<string, string | undefined>();

function forceUnreachableRapidMlx(): void {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  delete process.env.SANGFOR_EMBEDDING_FORCE_HASH;
  process.env.SANGFOR_EMBEDDING_PROVIDER = 'rapid-mlx';
  process.env.SANGFOR_RAPID_MLX_BASE_URL = 'http://127.0.0.1:1/v1'; // port 1: connection refused, fails fast
  process.env.SANGFOR_EMBEDDING_INIT_TIMEOUT_MS = '2000';
}

const dirs: string[] = [];
afterEach(() => {
  resetEmbeddingProviderCache();
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  savedEnv.clear();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const mk = () => { const d = mkdtempSync(join(tmpdir(), 'rag-fallback-')); dirs.push(d); return d; };

describe('embedding provider fallback honesty', () => {
  it('falls back to hash and reports it via wasEmbeddingFallback() when the configured backend is unreachable', async () => {
    resetEmbeddingProviderCache();
    forceUnreachableRapidMlx();
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const provider = await getEmbeddingProvider();
      expect(provider.name).toBe('hash');
      expect(wasEmbeddingFallback()).toBe(true);
      const warned = writeSpy.mock.calls.some(([msg]) => String(msg).includes("embedding provider 'rapid-mlx' unavailable — falling back to hash"));
      expect(warned).toBe(true);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('does NOT report a fallback when hash is the explicitly configured backend', async () => {
    resetEmbeddingProviderCache();
    process.env.SANGFOR_EMBEDDING_PROVIDER = 'hash';
    try {
      const provider = await getEmbeddingProvider();
      expect(provider.name).toBe('hash');
      expect(wasEmbeddingFallback()).toBe(false);
    } finally {
      delete process.env.SANGFOR_EMBEDDING_PROVIDER;
    }
  });

  it('ingestDocument records the ACTUAL backend used ("hash") in chunk metadata when a fallback occurred, not the configured model name', async () => {
    const dir = mk();
    const indexPath = join(dir, 'index.json');
    resetEmbeddingProviderCache();
    forceUnreachableRapidMlx();
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const docPath = join(dir, 'doc.md');
      writeFileSync(docPath, '# Doc\n\nSome content about storage network MTU.');
      const result = await ingestDocument({ filePath: docPath, product: 'HCI', indexPath });
      expect(result.embeddingBackend).toBe('hash');
      expect(result.chunks.every((c) => c.embeddingModel === 'hash')).toBe(true);
      expect(result.chunks.every((c) => c.embeddingBackend === 'hash')).toBe(true);
    } finally {
      writeSpy.mockRestore();
    }
  });
});

describe('exportRagIndexSummary — backend distribution', () => {
  it('reports hashChunks/semanticChunks/hashRatio/backends alongside chunkCount', async () => {
    const dir = mk();
    const indexPath = join(dir, 'index.json');
    process.env.SANGFOR_EMBEDDING_FORCE_HASH = '1';
    try {
      const docPath = join(dir, 'doc.md');
      writeFileSync(docPath, '# Doc\n\nStorage network content.');
      await ingestDocument({ filePath: docPath, product: 'HCI', indexPath });
    } finally {
      delete process.env.SANGFOR_EMBEDDING_FORCE_HASH;
    }
    const summary = exportRagIndexSummary(indexPath);
    expect(summary.chunkCount).toBeGreaterThan(0);
    expect(summary.hashChunks).toBe(summary.chunkCount);
    expect(summary.semanticChunks).toBe(0);
    expect(summary.hashRatio).toBe(1);
    expect(summary.backends).toEqual(summary.embeddingBackendCounts);
    expect((summary.backends as Record<string, number>).hash).toBe(summary.chunkCount);
  });
});

describe('sangfor_rag_search MCP tool — degraded flag surfaces on privacy_mode=summary', () => {
  it('marks the response degraded:true with a reason when the index is hash-only', async () => {
    process.env.MCP_NO_SERVE = '1';
    const dir = mk();
    const indexPath = join(dir, 'index.json');
    process.env.SANGFOR_EMBEDDING_FORCE_HASH = '1';
    try {
      const docPath = join(dir, 'doc.md');
      writeFileSync(docPath, '# HCI\n\nStorage network MTU validation before cluster init.');
      const { ingestDocument: ingest } = await import('../packages/sangfor-rag/src/index.js');
      await ingest({ filePath: docPath, product: 'HCI', indexPath });

      const mcp = await import('../apps/mcp-server/src/index.js');
      const handler = mcp.getToolHandler('sangfor_rag_search')!;
      const result: any = await handler({ query: 'MTU storage', indexPath, limit: 5, privacy_mode: 'summary' });
      expect(result.hits.length).toBeGreaterThan(0);
      expect(result.degraded).toBe(true);
      expect(typeof result.degradedReason).toBe('string');
      expect(result.degradedReason).toMatch(/hash-only/);
    } finally {
      delete process.env.SANGFOR_EMBEDDING_FORCE_HASH;
    }
  });
});
