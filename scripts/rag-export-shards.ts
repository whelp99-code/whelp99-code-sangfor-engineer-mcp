import { statSync } from 'node:fs';
import { loadRagIndex } from '../packages/sangfor-rag/src/index.js';
import {
  recommendStorageMigration,
  saveShardedJsonlIndex
} from '../packages/sangfor-rag/src/storage.js';

function main(): void {
  const indexPath = process.argv[2] ?? 'data/rag/index.json';
  const outputDir = process.argv[3] ?? 'data/rag/shards-next';
  const index = loadRagIndex(indexPath);
  const indexBytes = statSync(indexPath).size;
  const manifest = saveShardedJsonlIndex(index, outputDir);
  const recommendation = recommendStorageMigration(index.chunks.length, indexBytes);
  console.log(JSON.stringify({
    schemaVersion: 1,
    action: 'rag-export-shards',
    indexPath,
    outputDir,
    indexBytes,
    manifest,
    recommendation
  }, null, 2));
}

main();
