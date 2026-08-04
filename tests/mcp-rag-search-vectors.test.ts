import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Importing the MCP server module must NOT start the stdio readline loop.
process.env.MCP_NO_SERVE = '1';

let getToolHandler: (name: string) => ((args: unknown) => unknown | Promise<unknown>) | undefined;
let ingestDocument: typeof import('../packages/sangfor-rag/src/index.js').ingestDocument;

let dir: string;
let indexPath: string;

beforeAll(async () => {
  const mcp = await import('../apps/mcp-server/src/index.js');
  getToolHandler = mcp.getToolHandler as typeof getToolHandler;
  const rag = await import('../packages/sangfor-rag/src/index.js');
  ingestDocument = rag.ingestDocument;

  process.env.SANGFOR_EMBEDDING_FORCE_HASH = '1';
  dir = mkdtempSync(join(tmpdir(), 'mcp-rag-vec-'));
  indexPath = join(dir, 'index.json');
  const docPath = join(dir, 'hci.md');
  writeFileSync(docPath, '# HCI\n\nStorage network MTU validation before cluster init.');
  await ingestDocument({ filePath: docPath, product: 'HCI', indexPath });
});

afterAll(() => {
  delete process.env.SANGFOR_EMBEDDING_FORCE_HASH;
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  // no per-test mutation to clean up beyond the module-level fixture
});

describe('sangfor_rag_search — vector omission by default (C3)', () => {
  it('omits the vector field on each hit by default', async () => {
    const handler = getToolHandler('sangfor_rag_search')!;
    const result: any = await handler({ query: 'MTU storage', indexPath, limit: 5 });
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    for (const hit of result) {
      expect(hit).not.toHaveProperty('vector');
      // other chunk metadata must still be present — this is not the narrow
      // operator-console whitelist, just the vector stripped.
      expect(hit).toHaveProperty('id');
      expect(hit).toHaveProperty('text');
      expect(hit).toHaveProperty('contentHash');
    }
  });

  it('includes the vector field when include_vectors:true is passed', async () => {
    const handler = getToolHandler('sangfor_rag_search')!;
    const result: any = await handler({ query: 'MTU storage', indexPath, limit: 5, include_vectors: true });
    expect(result.length).toBeGreaterThan(0);
    for (const hit of result) {
      expect(Array.isArray(hit.vector)).toBe(true);
      expect(hit.vector.length).toBeGreaterThan(0);
    }
  });

  it('privacy_mode=summary is unaffected by include_vectors and stays id/title/score only', async () => {
    const handler = getToolHandler('sangfor_rag_search')!;
    const result: any = await handler({ query: 'MTU storage', indexPath, limit: 5, privacy_mode: 'summary', include_vectors: true });
    expect(result.hits.length).toBeGreaterThan(0);
    for (const hit of result.hits) {
      expect(Object.keys(hit).sort()).toEqual(['id', 'score', 'title'].sort());
    }
  });

  it('advertises include_vectors in the tool inputSchema', async () => {
    const mcp = await import('../apps/mcp-server/src/index.js');
    const tool = mcp.listTools().find((t) => t.name === 'sangfor_rag_search')!;
    expect(tool.inputSchema.properties.include_vectors).toBeDefined();
    expect(tool.inputSchema.properties.include_vectors.type).toBe('boolean');
  });
});
