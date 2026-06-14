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
  saveRagIndex,
  type RagDocumentChunk
} from '../packages/sangfor-rag/src/index.js';
import {
  getEmbeddingProvider,
  resetEmbeddingProviderCache,
  resolveEmbeddingModelFromEnv
} from '../packages/sangfor-rag/src/embedding-provider.js';
import { createHash } from 'node:crypto';
import { normalizeProduct } from '../packages/shared/src/index.js';

loadEnvFile('.env');

async function main() {
  resetEmbeddingProviderCache();
  const indexPath = process.argv[2] ?? 'data/rag/index.json';
  const rawDir = process.argv[3] ?? 'data/sources/raw';
  const provider = await getEmbeddingProvider();
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
    const body = raw.replace(/^---[\s\S]*?---\n/, '').trim();
    const parts = chunkText(body);
    const vectors = await provider.embed(parts);
    parts.forEach((text, i) => {
      const contentHash = createHash('sha256').update(`${filePath}:${i}:${text}`).digest('hex');
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
    const vectors = await provider.embed(texts);
    index.chunks.forEach((c, i) => {
      c.vector = vectors[i] ?? c.vector;
      c.embeddingBackend = provider.name;
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
