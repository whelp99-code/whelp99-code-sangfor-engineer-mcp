import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { loadEnvFile } from '../packages/sangfor-collector/src/load-env.js';
import { runLearnSourcesPipeline } from '../packages/sangfor-collector/src/learn-pipeline.js';
import { listSeedManuals } from '../packages/sangfor-knowledge/src/index.js';
import { listSeedWiki } from '../packages/sangfor-wiki/src/index.js';
import { ingestDocument, exportRagIndexSummary, ragSearch } from '../packages/sangfor-rag/src/index.js';
import { createFineTuneDataset, validateFineTuneDataset } from '../packages/sangfor-finetune/src/index.js';
import { listDemoDocTargets } from '../packages/sangfor-collector/src/demo-docs.js';
import { loadOneSessionFromEnv, resolveAuthTokens, verifyOneSession } from '../packages/sangfor-collector/src/index.js';

const REPORT_PATH = 'data/sources/learning-complete.json';

loadEnvFile('.env');

async function ingestSeeds(): Promise<number> {
  const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const TMP = 'data/seed-export';
  const RAG = 'data/rag/index.json';
  mkdirSync(TMP, { recursive: true });
  let n = 0;
  for (const chunk of [...listSeedManuals(), ...listSeedWiki()]) {
    const path = join(TMP, `${chunk.id}.md`);
    writeFileSync(path, `# ${chunk.title}\n\n${chunk.text}\n`, 'utf8');
    await ingestDocument({
      filePath: path,
      product: chunk.product,
      version: chunk.version,
      title: chunk.title,
      indexPath: RAG,
      sourceType: chunk.sourceType,
      trustLevel: 'official'
    });
    n++;
  }
  try { rmSync(TMP, { recursive: true }); } catch { /* ignore */ }
  return n;
}

async function main() {
  const steps: Record<string, unknown> = {};

  const config = loadOneSessionFromEnv();
  const tokens = await resolveAuthTokens(config);
  steps.auth = {
    oneSessionValid: tokens.oneAccessToken ? (await verifyOneSession(tokens.oneAccessToken, config.oneBaseUrl)).ok : false,
    hasKbToken: Boolean(tokens.kbToken),
    sources: tokens.sources
  };

  steps.learn = await runLearnSourcesPipeline({
    communityMaxThreadsPerForum: undefined,
    knowledgeMaxArticles: undefined,
    includeDemoDocs: true,
    fineTuneMaxExamples: undefined,
    ingestDocumentFn: ingestDocument,
    exportRagSummaryFn: exportRagIndexSummary,
    createFineTuneDatasetFn: createFineTuneDataset,
    validateFineTuneDatasetFn: validateFineTuneDataset
  });

  steps.seedManualsWiki = await ingestSeeds();
  steps.demoDocs = listDemoDocTargets().length;

  const finetunePath = 'data/finetune/sangfor-sources.jsonl';
  steps.finetuneValidation = validateFineTuneDataset(finetunePath);
  steps.rag = exportRagIndexSummary('data/rag/index.json');
  steps.ragSmoke = ragSearch({ query: 'Sangfor HCI deployment precheck', product: 'HCI', limit: 3 }).map(h => ({
    id: h.id,
    title: h.title,
    score: h.score
  }));

  const manifest = existsSync('data/sources/manifest.json')
    ? JSON.parse(readFileSync('data/sources/manifest.json', 'utf8'))
    : [];
  steps.manifestCount = Array.isArray(manifest) ? manifest.length : 0;
  steps.completedAt = new Date().toISOString();

  writeFileSync(REPORT_PATH, JSON.stringify(steps, null, 2));
  console.log(JSON.stringify({ reportPath: REPORT_PATH, ...steps }, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
