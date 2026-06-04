import { listDemoDocTargets } from '../packages/sangfor-collector/src/demo-docs.js';
import { loadEnvFile } from '../packages/sangfor-collector/src/load-env.js';
import { listSeedManuals } from '../packages/sangfor-knowledge/src/index.js';
import { listSeedWiki } from '../packages/sangfor-wiki/src/index.js';
import { ingestDocument, exportRagIndexSummary } from '../packages/sangfor-rag/src/index.js';

const RAG_INDEX_PATH = 'data/rag/index.json';

loadEnvFile('.env');

async function main() {
  const ingested = [];

  for (const demo of listDemoDocTargets()) {
    const result = await ingestDocument({
      filePath: demo.filePath,
      product: demo.product,
      version: demo.version,
      title: demo.title,
      indexPath: RAG_INDEX_PATH,
      sourceType: 'manual',
      trustLevel: 'official'
    });
    ingested.push({ file: demo.filePath, ...result });
  }

  const summary = {
    manuals: listSeedManuals().length,
    wikiChunks: listSeedWiki().length,
    rag: exportRagIndexSummary(RAG_INDEX_PATH),
    ingested
  };

  console.log(JSON.stringify(summary, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
