import { readFileSync } from 'node:fs';
import {
  collectCommunityThreads,
  collectKnowledgeCatalog,
  docsToFineTuneExamples,
  saveCollectedDocuments,
  saveCollectedManifest
} from '../packages/sangfor-collector/src/index.js';
import { ingestDocument, exportRagIndexSummary } from '../packages/sangfor-rag/src/index.js';
import { createFineTuneDataset, validateFineTuneDataset } from '../packages/sangfor-finetune/src/index.js';

const RAW_DIR = 'data/sources/raw';
const MANIFEST_PATH = 'data/sources/manifest.json';
const RAG_INDEX = 'data/rag/index.json';
const FINETUNE_PATH = 'data/finetune/sangfor-sources.jsonl';

async function main() {
  const kbToken = process.env.SANGFOR_KB_TOKEN;
  const communityMax = Number(process.env.SANGFOR_COMMUNITY_MAX_THREADS ?? 6);
  const knowledgeMax = Number(process.env.SANGFOR_KB_MAX_ARTICLES ?? 30);

  console.log('Collecting Sangfor Community (community.sangfor.com)...');
  const communityDocs = await collectCommunityThreads({
    communityMaxThreadsPerForum: communityMax
  });

  console.log('Collecting Sangfor Knowledge catalog (knowledgebase.sangfor.com / knowledge.sangfor.com)...');
  const knowledgeDocs = await collectKnowledgeCatalog({
    knowledgeMaxArticles: knowledgeMax,
    kbToken,
    kbBaseUrl: process.env.SANGFOR_KB_BASE_URL ?? 'https://knowledgebase.sangfor.com'
  });

  const all = [...knowledgeDocs, ...communityDocs];
  saveCollectedManifest(all, MANIFEST_PATH);
  const paths = saveCollectedDocuments(all, RAW_DIR);

  console.log(`Saved ${paths.length} raw documents to ${RAW_DIR}`);

  let ingestedChunks = 0;
  for (const path of paths) {
    const productMatch = readFileSync(path, 'utf8').match(/^product:\s*(\w+)/m);
    const product = productMatch?.[1] ?? 'HCI';
    const result = await ingestDocument({
      filePath: path,
      product,
      indexPath: RAG_INDEX,
      sourceType: 'manual',
      trustLevel: path.includes('community') ? 'internal' : 'official',
      title: path.split('/').pop()?.replace('.md', '')
    });
    ingestedChunks += result.chunkCount;
  }

  const byProduct = all.reduce<Record<string, number>>((acc, d) => {
    acc[d.product] = (acc[d.product] ?? 0) + 1;
    return acc;
  }, {});

  const finetuneExamples = docsToFineTuneExamples(all.slice(0, 50));
  const dataset = createFineTuneDataset({
    product: 'HCI',
    taskType: 'lesson_extraction',
    outputPath: FINETUNE_PATH,
    examples: finetuneExamples
  });

  const validation = validateFineTuneDataset(dataset.path);

  console.log(JSON.stringify({
    collected: all.length,
    community: communityDocs.length,
    knowledge: knowledgeDocs.length,
    kbTokenUsed: Boolean(kbToken),
    byProduct,
    rawFiles: paths.length,
    rag: exportRagIndexSummary(RAG_INDEX),
    ingestedChunks,
    finetune: { path: dataset.path, count: dataset.count, validation }
  }, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
