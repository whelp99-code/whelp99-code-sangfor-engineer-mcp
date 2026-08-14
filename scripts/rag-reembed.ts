/**
 * Re-embed all chunks in data/rag/index.json using current embedding provider.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnvFile } from '../packages/sangfor-collector/src/load-env.js';
import {
  chunkText,
  extractTextFromFile,
  loadRagIndex,
  ragChunkContentHash,
  saveRagIndex,
  type RagDocumentChunk
} from '../packages/sangfor-rag/src/index.js';
import {
  embedForRole,
  getEmbeddingProvider,
  resetEmbeddingProviderCache,
  resolveEmbeddingModelFromEnv,
  wasEmbeddingFallback
} from '../packages/sangfor-rag/src/embedding-provider.js';
import { normalizeProduct } from '../packages/shared/src/index.js';

loadEnvFile('.env');

async function main() {
  resetEmbeddingProviderCache();
  const indexPath = process.argv[2] ?? 'data/rag/index.json';
  const rawDir = process.argv[3] ?? 'data/sources/raw';
  const provider = await getEmbeddingProvider();
  if ((provider.name === 'hash' || wasEmbeddingFallback()) && process.env.SANGFOR_ALLOW_HASH_REEMBED !== '1') {
    throw new Error('Refusing to re-embed with hash fallback. Restore the semantic embedding provider or set SANGFOR_ALLOW_HASH_REEMBED=1 for an explicit hash-only rebuild.');
  }
  console.error(`Re-embed with ${provider.name} (dims probe...)`);

  const index = loadRagIndex(indexPath);
  const byHash = new Map(index.chunks.map(c => [c.contentHash, c]));

  const files = existsSync(rawDir)
    ? readdirSync(rawDir).filter(f => f.endsWith('.md'))
    : [];

  let updated = 0;
  for (const file of files) {
    const filePath = join(rawDir, file);
    const raw = readFileSync(filePath, 'utf8');
    const product = (raw.match(/^product:\s*(\w+)/m)?.[1] ?? 'HCI');
    const title = raw.match(/^#\s+(.+)/m)?.[1] ?? file;
    // Chunk exactly as ingestion did — from the whole file, front matter included.
    // Stripping it here re-cut every chunk, so no contentHash matched an indexed row
    // and a "re-embed" appended a second copy of the corpus next to the stale one.
    const parts = chunkText(await extractTextFromFile(filePath));
    const vectors = await embedForRole(provider, parts, 'document');
    parts.forEach((text, i) => {
      const contentHash = ragChunkContentHash(filePath, i, text);
      const vector = vectors[i];
      if (!vector) return;
      const existing = byHash.get(contentHash);
      const row: RagDocumentChunk = existing ?? {
        id: `reembed_${file}_${i}`,
        sourceType: 'manual',
        product: normalizeProduct(product),
        title,
        section: `chunk-${i + 1}`,
        text,
        trustLevel: 'official',
        vector,
        contentHash,
        filePath,
        embeddingBackend: provider.name,
        embeddingModel: resolveEmbeddingModelFromEnv(),
        vectorDims: vector.length
      };
      row.vector = vector;
      row.embeddingBackend = provider.name;
      row.embeddingModel = resolveEmbeddingModelFromEnv();
      row.vectorDims = vector.length;
      byHash.set(contentHash, row);
      updated += 1;
    });
  }

  if (!files.length) {
    const texts = index.chunks.map(c => c.text);
    const vectors = await embedForRole(provider, texts, 'document');
    index.chunks.forEach((c, i) => {
      c.vector = vectors[i] ?? c.vector;
      c.embeddingBackend = provider.name;
      // Provenance must move with the vector: leaving the previous model name on a
      // freshly embedded row makes the index claim vectors it no longer holds.
      c.embeddingModel = resolveEmbeddingModelFromEnv();
      c.vectorDims = c.vector.length;
    });
    updated = index.chunks.length;
  } else {
    index.chunks = [...byHash.values()];
  }

  index.version = provider.name !== 'hash' ? 2 : index.version;
  saveRagIndex(index, indexPath);
  console.log(JSON.stringify({ indexPath, provider: provider.name, updated, chunkCount: index.chunks.length }, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
