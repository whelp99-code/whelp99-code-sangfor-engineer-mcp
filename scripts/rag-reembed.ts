/** Re-embed a stored corpus into a new candidate; ingestion owns source updates/deletions. */
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { verifyReembedCheckpoint } from '../packages/sangfor-rag/src/reembed-checkpoint.js';
import { resolve } from 'node:path';
import { actualEmbeddingModelName } from '../packages/sangfor-rag/src/rag-ingest.js';
import { resolveEmbeddingSpace } from '../packages/sangfor-rag/src/embedding-space.js';
import { loadEnvFile } from '../packages/sangfor-collector/src/load-env.js';
import { loadRagIndex, saveRagIndex, type RagDocumentChunk } from '../packages/sangfor-rag/src/index.js';
import { embedForRole, getEmbeddingProvider, resetEmbeddingProviderCache, wasEmbeddingFallback } from '../packages/sangfor-rag/src/embedding-provider.js';

loadEnvFile('.env');

async function main() {
  resetEmbeddingProviderCache();
  const indexPath = process.argv[2] ?? 'data/rag/index.json';
  // argv[3] was the raw directory. Preserve positional compatibility but do not
  // discover documents or guess official trust/product during a vector migration.
  const outputPath = process.argv[4] ?? `${indexPath}.candidate.json`;
  if (resolve(outputPath) === resolve(indexPath) || existsSync(outputPath)) {
    throw new Error('RAG_REEMBED_REQUIRES_NEW_CANDIDATE_PATH');
  }
  const provider = await getEmbeddingProvider();
  if ((provider.name === 'hash' || wasEmbeddingFallback()) && process.env.SANGFOR_ALLOW_HASH_REEMBED !== '1') {
    throw new Error('Refusing to re-embed with hash fallback. Restore the semantic embedding provider or set SANGFOR_ALLOW_HASH_REEMBED=1 for an explicit hash-only rebuild.');
  }
  const sourceBytes = readFileSync(indexPath);
  const source = loadRagIndex(indexPath);
  const embeddingModel = actualEmbeddingModelName(provider);
  const checkpointRoot = process.env.SANGFOR_RAG_REEMBED_CHECKPOINT_DIR;
  const checkpointIdentity = createHash('sha256').update(sourceBytes).update(JSON.stringify({ model: embeddingModel, backend: provider.name,
    revision: process.env.SANGFOR_EMBEDDING_MODEL_REVISION ?? null })).digest('hex');
  let resumed = 0;
  const chunks: RagDocumentChunk[] = [];
  for (let start = 0; start < source.chunks.length; start += 32) {
    const batch = source.chunks.slice(start, start + 32);
    const checkpointPath = checkpointRoot ? resolve(checkpointRoot, checkpointIdentity, `${String(start).padStart(9, '0')}.json`) : undefined;
    if (checkpointPath && existsSync(checkpointPath)) {
      const saved = loadRagIndex(checkpointPath).chunks;
      verifyReembedCheckpoint(saved, batch, provider.name, embeddingModel);
      chunks.push(...saved); resumed += saved.length;
      continue;
    }
    const vectors = await embedForRole(provider, batch.map((chunk) => chunk.text), 'document');
    const completedBatch = batch.map((chunk, i) => {
      const vector = vectors[i];
      const embeddingSpace = resolveEmbeddingSpace(embeddingModel, vector.length, provider.name);
      if (!embeddingSpace) throw new Error('RAG_REEMBED_MODEL_REVISION_REQUIRED');
      return { ...chunk, vector, embeddingBackend: provider.name, embeddingModel, vectorDims: vector.length, embeddingSpace };
    });
    verifyReembedCheckpoint(completedBatch, batch, provider.name, embeddingModel);
    if (checkpointPath) saveRagIndex({ ...source, chunks: completedBatch }, checkpointPath);
    chunks.push(...completedBatch);
    if (chunks.length % 1024 === 0 || chunks.length === source.chunks.length) console.error(JSON.stringify({ completed: chunks.length, total: source.chunks.length, resumed }));
  }
  if (!readFileSync(indexPath).equals(sourceBytes)) throw new Error('RAG_REEMBED_SOURCE_CHANGED');
  saveRagIndex({ ...source, version: provider.name === 'hash' ? source.version : 2, chunks }, outputPath);
  console.log(JSON.stringify({ sourceIndexPath: indexPath, candidateIndexPath: outputPath, provider: provider.name, updated: chunks.length, chunkCount: chunks.length, resumed, checkpointIdentity: checkpointRoot ? checkpointIdentity : undefined }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
