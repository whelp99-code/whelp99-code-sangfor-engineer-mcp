import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadRagIndex, saveRagIndex } from '@sangfor/rag';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'rag-reembed-')); dirs.push(dir);
  const source = join(dir, 'index.json');
  saveRagIndex({ version: 2, updatedAt: '2026-01-01T00:00:00Z', chunks: [{
    id: 'old', filePath: 'source.md', sourceType: 'manual', product: 'OTHER', title: 'source', text: 'MTU 9000',
    trustLevel: 'internal', contentHash: 'unchanged', vector: [1, 0], embeddingBackend: 'rapid-mlx', embeddingModel: 'old', vectorDims: 2,
  }] }, source);
  return { dir, source, candidate: join(dir, 'candidate.json') };
}
function run(source: string, candidate: string, allow = '1') {
  return spawnSync(process.execPath, ['--import', 'tsx', 'scripts/rag-reembed.ts', source, 'unused-raw-dir', candidate], {
    encoding: 'utf8', env: { ...process.env, SANGFOR_EMBEDDING_FORCE_HASH: '1', SANGFOR_ALLOW_HASH_REEMBED: allow },
  });
}
describe('RAG candidate reembedding CLI', () => {
  it('preserves the original and all document metadata while replacing vector provenance', () => {
    const { source, candidate } = fixture(); const before = readFileSync(source);
    const result = run(source, candidate);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(source)).toEqual(before);
    expect(loadRagIndex(candidate).chunks[0]).toMatchObject({ id: 'old', product: 'OTHER', trustLevel: 'internal', contentHash: 'unchanged',
      embeddingBackend: 'hash', embeddingModel: 'hash', vectorDims: 384, embeddingSpace: { revision: 'sha256-buckets-v1' } });
  });
  it('refuses overwriting either the source or an existing candidate', () => {
    const { source, candidate } = fixture(); const before = readFileSync(source);
    expect(run(source, source).stderr).toContain('RAG_REEMBED_REQUIRES_NEW_CANDIDATE_PATH');
    writeFileSync(candidate, 'preserve me');
    expect(run(source, candidate).stderr).toContain('RAG_REEMBED_REQUIRES_NEW_CANDIDATE_PATH');
    expect(readFileSync(source)).toEqual(before);
    expect(readFileSync(candidate, 'utf8')).toBe('preserve me');
  });
  it('requires explicit consent for a hash-only candidate', () => {
    const { source, candidate } = fixture();
    const result = run(source, candidate, '0');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Refusing to re-embed with hash fallback');
  });
});
