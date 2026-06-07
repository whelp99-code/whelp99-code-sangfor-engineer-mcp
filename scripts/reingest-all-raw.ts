import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnvFile } from '../packages/sangfor-collector/src/load-env.js';
import { ingestDocument, exportRagIndexSummary } from '../packages/sangfor-rag/src/index.js';

loadEnvFile('.env');

const rawDir = 'data/sources/raw';
const indexPath = 'data/rag/index.json';

// Clear existing index to rebuild from scratch
writeFileSync(indexPath, JSON.stringify({ version: 1, chunks: [], updatedAt: new Date().toISOString() }, null, 2));

const files = readdirSync(rawDir).filter(f => f.endsWith('.md'));
let totalChunks = 0;
let errors = 0;

for (const file of files) {
  const path = join(rawDir, file);
  try {
    const content = readFileSync(path, 'utf8');
    const productMatch = content.match(/^product:\s*(\w+)/m);
    const product = productMatch?.[1] ?? 'HCI';
    
    const result = await ingestDocument({
      filePath: path,
      product,
      indexPath,
      sourceType: 'manual',
      trustLevel: 'official',
      title: file.replace('.md', '')
    });
    totalChunks += result.chunkCount;
  } catch (err) {
    errors++;
    console.error(`Error ingesting ${file}: ${err}`);
  }
}

const summary = exportRagIndexSummary(indexPath);
console.log(JSON.stringify({ 
  files: files.length, 
  chunks: totalChunks, 
  errors,
  summary 
}, null, 2));
