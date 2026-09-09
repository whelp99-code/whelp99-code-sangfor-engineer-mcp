/** Re-embed a stored corpus into a new candidate; ingestion owns source updates/deletions. */
import { existsSync } from 'node:fs';
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
  const source = loadRagIndex(indexPath);
  const chunks: RagDocumentChunk[] = [];
  for (let start = 0; start < source.chunks.length; start += 32) {
    const batch = source.chunks.slice(start, start + 32);
    const vectors = await embedForRole(provider, batch.map((chunk) => chunk.text), 'document');
    batch.forEach((chunk, i) => {
      const vector = vectors[i];
      const embeddingModel = actualEmbeddingModelName(provider);
      const embeddingSpace = resolveEmbeddingSpace(embeddingModel, vector.length, provider.name);
      if (!embeddingSpace) throw new Error('RAG_REEMBED_MODEL_REVISION_REQUIRED');
      chunks.push({ ...chunk, vector, embeddingBackend: provider.name, embeddingModel, vectorDims: vector.length, embeddingSpace });
    });
  }
  saveRagIndex({ ...source, version: provider.name === 'hash' ? source.version : 2, chunks }, outputPath);
  console.log(JSON.stringify({ sourceIndexPath: indexPath, candidateIndexPath: outputPath, provider: provider.name, updated: chunks.length, chunkCount: chunks.length }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
