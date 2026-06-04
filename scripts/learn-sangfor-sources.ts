import { loadEnvFile } from '../packages/sangfor-collector/src/load-env.js';
import { runLearnSourcesPipeline } from '../packages/sangfor-collector/src/learn-pipeline.js';
import { ingestDocument, exportRagIndexSummary } from '../packages/sangfor-rag/src/index.js';
import { createFineTuneDataset, validateFineTuneDataset } from '../packages/sangfor-finetune/src/index.js';

loadEnvFile('.env');

async function main() {
  const result = await runLearnSourcesPipeline({
    ingestDocumentFn: ingestDocument,
    exportRagSummaryFn: exportRagIndexSummary,
    createFineTuneDatasetFn: createFineTuneDataset,
    validateFineTuneDatasetFn: validateFineTuneDataset
  });

  if (result.oneSession) {
    console.log(`ONE session (one.sangfor.com): ${result.oneSession.ok ? 'valid' : 'invalid'} [${result.auth.sources.join(', ')}]`);
  } else {
    console.log('ONE session: not configured (public catalog + community only)');
  }

  console.log(JSON.stringify(result, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
