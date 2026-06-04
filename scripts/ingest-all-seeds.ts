import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { listSeedManuals } from '../packages/sangfor-knowledge/src/index.js';
import { listSeedWiki } from '../packages/sangfor-wiki/src/index.js';
import { ingestDocument, exportRagIndexSummary } from '../packages/sangfor-rag/src/index.js';
import { loadEnvFile } from '../packages/sangfor-collector/src/load-env.js';

const RAG_INDEX = 'data/rag/index.json';
const TMP = 'data/seed-export';

loadEnvFile('.env');

async function main() {
  mkdirSync(TMP, { recursive: true });
  const ingested: Array<{ id: string; chunkCount: number; kind: string }> = [];

  for (const chunk of [...listSeedManuals(), ...listSeedWiki()]) {
    const safe = chunk.id.replace(/[^a-zA-Z0-9_-]/g, '_');
    const path = join(TMP, `${safe}.md`);
    const body = [
      `# ${chunk.title}`,
      chunk.section ? `## ${chunk.section}` : '',
      '',
      chunk.text,
      '',
      `Source: seed/${chunk.sourceType}`,
      `Product: ${chunk.product}${chunk.version ? ` v${chunk.version}` : ''}`
    ].filter(Boolean).join('\n');
    writeFileSync(path, body, 'utf8');
    const result = await ingestDocument({
      filePath: path,
      product: chunk.product,
      version: chunk.version,
      title: chunk.title,
      indexPath: RAG_INDEX,
      sourceType: chunk.sourceType,
      trustLevel: chunk.trustLevel ?? 'official'
    });
    ingested.push({ id: chunk.id, chunkCount: result.chunkCount, kind: chunk.sourceType });
  }

  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    // ignore
  }

  console.log(JSON.stringify({
    seedChunks: ingested.length,
    ingested,
    rag: exportRagIndexSummary(RAG_INDEX)
  }, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
