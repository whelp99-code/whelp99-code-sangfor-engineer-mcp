import { expect, it } from 'vitest';
import { verifyReembedCheckpoint } from '../packages/sangfor-rag/src/reembed-checkpoint.js';
import { resolveEmbeddingSpace } from '../packages/sangfor-rag/src/embedding-space.js';
import { hashEmbedding } from '../packages/sangfor-rag/src/hash-embedding.js';
import type { RagDocumentChunk } from '../packages/sangfor-rag/src/rag-types.js';
const source: RagDocumentChunk = { id: 'source', title: 'Guide', text: 'Check MTU', product: 'HCI', filePath: 'manual.md', sourceType: 'manual', trustLevel: 'official', vector: [], contentHash: 'source-hash' };
const vector = hashEmbedding(source.text);
const saved: RagDocumentChunk = { ...source, vector, embeddingBackend: 'hash', embeddingModel: 'hash', vectorDims: vector.length, embeddingSpace: resolveEmbeddingSpace('hash', vector.length, 'hash') };
it('accepts the same source and verified model space on resume', () => {
  expect(() => verifyReembedCheckpoint([saved], [source], 'hash', 'hash')).not.toThrow();
});
it('refuses missing, relabelled or corrupt checkpoint batches', () => {
  expect(() => verifyReembedCheckpoint([], [source], 'hash', 'hash')).toThrow('RAG_REEMBED_CHECKPOINT_COUNT');
  expect(() => verifyReembedCheckpoint([{ ...saved, tenantId: 'other' }], [source], 'hash', 'hash')).toThrow('RAG_REEMBED_CHECKPOINT_SOURCE');
  expect(() => verifyReembedCheckpoint([{ ...saved, text: 'Other source' }], [source], 'hash', 'hash')).toThrow('RAG_REEMBED_CHECKPOINT_SOURCE');
  expect(() => verifyReembedCheckpoint([{ ...saved, embeddingModel: 'other' }], [source], 'hash', 'hash')).toThrow('RAG_REEMBED_CHECKPOINT_SPACE');
  expect(() => verifyReembedCheckpoint([{ ...saved, vector: vector.map(() => NaN) }], [source], 'hash', 'hash')).toThrow('RAG_REEMBED_CHECKPOINT_SPACE');
});

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
it('resumes completed CLI batches and publishes only a complete new candidate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reembed-checkpoint-'));
  try {
    const index = join(dir, 'source.json');
    writeFileSync(index, JSON.stringify({ version: 1, updatedAt: new Date(0).toISOString(), chunks: Array.from({ length: 33 }, (_, i) => ({ ...source, id: `source-${i}` })) }));
    const run = (output: string) => JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', resolve('scripts/rag-reembed.ts'), index, 'unused', join(dir, output)], { encoding: 'utf8', env: { ...process.env, SANGFOR_EMBEDDING_PROVIDER: 'hash', SANGFOR_ALLOW_HASH_REEMBED: '1', SANGFOR_RAG_REEMBED_CHECKPOINT_DIR: join(dir, 'checkpoints'), SANGFOR_BLRO_AUTHORITY_STORE: 'local' } }));
    expect(run('first.json')).toMatchObject({ chunkCount: 33, resumed: 0 });
    expect(run('second.json')).toMatchObject({ chunkCount: 33, resumed: 33 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
