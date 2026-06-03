import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { listSeedManuals } from '../packages/sangfor-knowledge/src/index.js';
import { listSeedWiki } from '../packages/sangfor-wiki/src/index.js';
import { ingestDocument, exportRagIndexSummary } from '../packages/sangfor-rag/src/index.js';

const DEMO_DOCS_DIR = 'data/demo-docs';
const RAG_INDEX_PATH = 'data/rag/index.json';

const PRODUCT_BY_FILE: Record<string, { product: string; version?: string }> = {
  'hci-storage-network.md': { product: 'HCI', version: '6.11' },
  'iag-policy-baseline.md': { product: 'IAG' },
  'endpoint-secure-rollout.md': { product: 'ENDPOINT_SECURE' },
  'cyber-command-onboarding.md': { product: 'CYBER_COMMAND' }
};

async function main() {
  const files = readdirSync(DEMO_DOCS_DIR).filter(f => f.endsWith('.md'));
  const ingested = [];

  for (const file of files) {
    const meta = PRODUCT_BY_FILE[file];
    if (!meta) continue;
    const filePath = join(DEMO_DOCS_DIR, file);
    const result = await ingestDocument({
      filePath,
      product: meta.product,
      version: meta.version,
      title: file.replace('.md', ''),
      indexPath: RAG_INDEX_PATH,
      sourceType: 'manual',
      trustLevel: 'official'
    });
    ingested.push({ file, ...result });
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
