import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ingestDocument } from '../packages/sangfor-rag/src/index.js';

process.env.MCP_NO_SERVE = '1';
process.env.SANGFOR_EMBEDDING_FORCE_HASH = '1';
const { getToolHandler } = await import('../apps/mcp-server/src/index.js');

const root = mkdtempSync(join(tmpdir(), 'hiware-learning-'));
const indexPath = join(root, 'index.json');
const sourcePath = resolve('data/sources/hiware-menu-inventory.md');

afterAll(() => {
  delete process.env.SANGFOR_EMBEDDING_FORCE_HASH;
  rmSync(root, { recursive: true, force: true });
});

describe('HIWARE learning source', () => {
  it('is ingested under HIWARE and retrieved through the MCP search tool', async () => {
    await ingestDocument({
      filePath: sourcePath,
      product: 'HIWARE',
      sourceType: 'manual',
      trustLevel: 'internal',
      indexPath
    });
    const handler = getToolHandler('sangfor_rag_search');

    const hits = await handler?.({
      product: 'HIWARE',
      query: 'Google OTP 장비별 2FA 적용',
      indexPath,
      limit: 3
    });

    expect(hits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          product: 'HIWARE',
          filePath: sourcePath
        })
      ])
    );
  });
});
