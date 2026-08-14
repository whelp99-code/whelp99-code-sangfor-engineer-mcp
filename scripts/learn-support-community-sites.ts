import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  loadCollectedManifest,
  saveCollectedManifest,
  type CollectedDocument
} from '../packages/sangfor-collector/src/index.js';
import {
  isDocumentFineTuneEligible,
  prepareLearningTextForFineTune,
  runTwoSiteLearning,
  validateSiteLearningReport,
  type SiteLearningDocument
} from '../packages/sangfor-collector/src/site-learning-crawler.js';
import { createFineTuneDataset, validateFineTuneDataset } from '../packages/sangfor-finetune/src/index.js';
import { exportRagIndexSummary, ingestDocumentsBatch } from '../packages/sangfor-rag/src/index.js';

const rawDir = process.env.SANGFOR_SOURCES_RAW_ROOT ?? 'data/sources/raw';
const reportPath = process.env.SANGFOR_TWO_SITE_REPORT_PATH ?? 'data/sources/two-site-learning-report.json';
const checkpointPath = process.env.SANGFOR_TWO_SITE_CHECKPOINT_PATH
  ?? 'data/sources/two-site-learning-checkpoint.json';
const manifestPath = process.env.SANGFOR_SOURCES_MANIFEST_PATH ?? 'data/sources/manifest.json';
const ragIndexPath = process.env.SANGFOR_RAG_INDEX_PATH ?? 'data/rag/index.json';
const finetunePath = process.env.SANGFOR_FINETUNE_PATH ?? 'data/finetune/sangfor-sources.jsonl';

const HELP_TEXT = `Usage: pnpm run learn:sites:full

Crawls the registered Sangfor Support and Community learning sites, writes raw
documents, updates the collected-source manifest, ingests documents into the RAG
index, and rebuilds the lesson-extraction fine-tune dataset.

Important environment controls:
  SANGFOR_TWO_SITE_FRESH=1                  remove the previous checkpoint first
  SANGFOR_SUPPORT_MAX_VERSIONS=<n>          cap Support product versions
  SANGFOR_SUPPORT_MAX_DOCUMENTS=<n>         cap Support documents
  SANGFOR_COMMUNITY_MAX_FORUMS=<n>          cap Community forums
  SANGFOR_COMMUNITY_MAX_PAGES_PER_FORUM=<n> cap Community forum pages
  SANGFOR_COMMUNITY_MAX_THREADS=<n>         cap Community threads
  SANGFOR_SITE_CRAWL_DELAY_MS=<n>           polite delay between page actions
`;

function optionalLimit(name: string): number | undefined {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function toCollectedDocument(document: SiteLearningDocument): CollectedDocument {
  return {
    id: document.id,
    source: document.source,
    sourceUrl: document.sourceUrl,
    product: document.product,
    title: document.title,
    text: document.text,
    trustLevel: document.trustLevel,
    fetchedAt: document.fetchedAt
  };
}

function mergeManifest(current: CollectedDocument[], added: CollectedDocument[]): CollectedDocument[] {
  const byId = new Map(current.map((document) => [document.id, document]));
  for (const document of added) byId.set(document.id, document);
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

async function main(): Promise<void> {
  mkdirSync(rawDir, { recursive: true });
  mkdirSync(dirname(reportPath), { recursive: true });
  if (process.env.SANGFOR_TWO_SITE_FRESH === '1') {
    rmSync(checkpointPath, { force: true });
  }

  const result = await runTwoSiteLearning({
    rawDir,
    reportPath,
    checkpointPath,
    maxSupportVersions: optionalLimit('SANGFOR_SUPPORT_MAX_VERSIONS'),
    maxSupportDocuments: optionalLimit('SANGFOR_SUPPORT_MAX_DOCUMENTS'),
    maxCommunityForums: optionalLimit('SANGFOR_COMMUNITY_MAX_FORUMS'),
    maxCommunityPagesPerForum: optionalLimit('SANGFOR_COMMUNITY_MAX_PAGES_PER_FORUM'),
    maxCommunityThreads: optionalLimit('SANGFOR_COMMUNITY_MAX_THREADS'),
    includeSupportManuals: process.env.SANGFOR_INCLUDE_SUPPORT_MANUALS !== '0',
    includeSupportPractices: process.env.SANGFOR_INCLUDE_SUPPORT_PRACTICES !== '0',
    includeSupportCases: process.env.SANGFOR_INCLUDE_SUPPORT_CASES !== '0',
    delayMs: Number(process.env.SANGFOR_SITE_CRAWL_DELAY_MS ?? 350),
    browserExecutablePath: process.env.SANGFOR_CHROMIUM_PATH,
    userDataDir: process.env.SANGFOR_TWO_SITE_USER_DATA_DIR
  });
  const crawlValidation = validateSiteLearningReport(result.report);
  if (!crawlValidation.ok) {
    throw new Error(`TWO_SITE_CRAWL_INVALID: ${crawlValidation.errors.join('; ')}`);
  }

  const ingested = await ingestDocumentsBatch(result.files.map((filePath, index) => {
    const document = result.documents[index];
    return {
      filePath,
      product: document.product,
      indexPath: ragIndexPath,
      sourceType: document.source === 'community_site' ? 'lesson' : 'manual',
      trustLevel: document.trustLevel,
      title: document.title
    };
  }));

  const existing = existsSync(manifestPath)
    ? loadCollectedManifest(manifestPath) as CollectedDocument[]
    : [];
  const manifest = mergeManifest(existing, result.documents.map(toCollectedDocument));
  saveCollectedManifest(manifest, manifestPath);

  const fineTuneDocuments = manifest.flatMap((document) => {
    const safeText = prepareLearningTextForFineTune(document.text);
    return isDocumentFineTuneEligible(document.title, safeText) ? [{ document, safeText }] : [];
  });
  const examples = fineTuneDocuments.map(({ document, safeText }) => ({
    product: document.product,
    input: [
      `Extract a reusable Sangfor engineering lesson from: ${document.title}`,
      safeText.slice(0, 6_000)
    ].join('\n\n'),
    expectedOutput: [
      `Source: ${document.sourceUrl}`,
      `Product: ${document.product}`,
      `Trust: ${document.trustLevel}`,
      safeText.slice(0, 1_500)
    ].join('\n'),
    source: document.sourceUrl
  }));
  const dataset = createFineTuneDataset({
    product: 'HCI',
    taskType: 'lesson_extraction',
    outputPath: finetunePath,
    examples
  });
  const validation = validateFineTuneDataset(dataset.path);
  if (!validation.ok) {
    throw new Error(`TWO_SITE_FINETUNE_INVALID: ${validation.errors.join('; ')}`);
  }
  const finalReport = {
    ...result.report,
    crawlValidation,
    files: result.files.length,
    chunks: ingested.chunkCount,
    rag: exportRagIndexSummary(ragIndexPath),
    manifest: manifest.length,
    finetune: {
      count: dataset.count,
      excludedSensitiveTopicDocuments: manifest.length - fineTuneDocuments.length,
      validation
    }
  };
  writeFileSync(reportPath, JSON.stringify(finalReport, null, 2), 'utf8');
  console.log(JSON.stringify(finalReport, null, 2));
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(HELP_TEXT);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
