/**
 * Ingest markdown files from data/sources/raw/browser_*.md into RAG.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnvFile } from '../packages/sangfor-collector/src/load-env.js';
import { ingestDocument, exportRagIndexSummary } from '../packages/sangfor-rag/src/index.js';

loadEnvFile('.env');

const rawDir = 'data/sources/raw';
const indexPath = 'data/rag/index.json';

async function main() {
  const files = readdirSync(rawDir).filter(f =>
    (f.startsWith('browser_') || f.startsWith('catalog_')) && f.endsWith('.md')
  );
  let chunks = 0;
  for (const file of files) {
    const path = join(rawDir, file);
    const productMatch = readFileSync(path, 'utf8').match(/^product:\s*(\w+)/m);
    const product = (productMatch?.[1] ?? 'HCI') as 'HCI' | 'CYBER_COMMAND' | 'ENDPOINT_SECURE' | 'IAG';
    const result = await ingestDocument({
      filePath: path,
      product,
      indexPath,
      sourceType: 'manual',
      trustLevel: 'official',
      title: file.replace('.md', '')
    });
    chunks += result.chunkCount;
  }
  console.log(JSON.stringify({ files: files.length, chunks, rag: exportRagIndexSummary(indexPath) }, null, 2));
}

main();
