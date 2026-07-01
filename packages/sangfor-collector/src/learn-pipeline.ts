import { readFileSync } from 'node:fs';
import {
  collectCommunityThreads,
  collectKnowledgeCatalog,
  docsToFineTuneExamples,
  loadOneSessionFromEnv,
  resolveAuthTokens,
  saveCollectedDocuments,
  saveCollectedManifest,
  verifyOneSession,
  type CollectedDocument
} from './index.js';
import { listDemoDocTargets } from './demo-docs.js';
import { parseCollectionLimit } from './load-env.js';

/**
 * Resolve the product a collected document declares in its frontmatter header.
 * Returns null when no `product:` header is present — callers MUST NOT fabricate
 * a product (previously this silently defaulted to 'HCI', misattributing
 * unrelated manuals to HCI and producing falsely-labelled "official" citations).
 */
export function resolveDocumentProduct(content: string): string | null {
  const match = content.match(/^product:\s*(\w+)/m);
  return match?.[1] ?? null;
}

export interface LearnPipelineResult {
  collected: number;
  community: number;
  knowledge: number;
  demoDocsIngested: number;
  auth: { sources: string[]; oneAccessToken: boolean; kbToken: boolean };
  kbTokenUsed: boolean;
  byProduct: Record<string, number>;
  rawFiles: number;
  ingestedChunks: number;
  rag: unknown;
  finetune: { path: string; count: number; validation: unknown };
  oneSession?: { ok: boolean };
}

export interface LearnPipelineOptions {
  rawDir?: string;
  manifestPath?: string;
  ragIndexPath?: string;
  finetunePath?: string;
  communityMaxThreadsPerForum?: number;
  knowledgeMaxArticles?: number;
  includeDemoDocs?: boolean;
  fineTuneMaxExamples?: number;
  kbBaseUrl?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ingestDocumentFn: (args: any) => Promise<{ chunkCount: number }>;
  exportRagSummaryFn: (indexPath: string) => unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createFineTuneDatasetFn: (args: any) => { path: string; count: number };
  validateFineTuneDatasetFn: (path: string) => unknown;
}

const DEFAULTS = {
  rawDir: 'data/sources/raw',
  manifestPath: 'data/sources/manifest.json',
  ragIndexPath: 'data/rag/index.json',
  finetunePath: 'data/finetune/sangfor-sources.jsonl'
};

export async function runLearnSourcesPipeline(
  options: LearnPipelineOptions
): Promise<LearnPipelineResult> {
  const rawDir = options.rawDir ?? DEFAULTS.rawDir;
  const manifestPath = options.manifestPath ?? DEFAULTS.manifestPath;
  const ragIndexPath = options.ragIndexPath ?? DEFAULTS.ragIndexPath;
  const finetunePath = options.finetunePath ?? DEFAULTS.finetunePath;

  const sessionConfig = loadOneSessionFromEnv();
  const tokens = await resolveAuthTokens(sessionConfig);
  const kbToken = tokens.kbToken;

  const communityMax = options.communityMaxThreadsPerForum
    ?? parseCollectionLimit(process.env.SANGFOR_COMMUNITY_MAX_THREADS, 12);
  const knowledgeMax = options.knowledgeMaxArticles
    ?? parseCollectionLimit(process.env.SANGFOR_KB_MAX_ARTICLES, 80);
  const includeDemo = options.includeDemoDocs
    ?? process.env.SANGFOR_INCLUDE_DEMO_DOCS !== '0';
  const fineTuneCap = options.fineTuneMaxExamples
    ?? parseCollectionLimit(process.env.SANGFOR_FINETUNE_MAX_EXAMPLES, 80);

  let oneSession: { ok: boolean } | undefined;
  if (tokens.oneAccessToken) {
    oneSession = await verifyOneSession(tokens.oneAccessToken, sessionConfig.oneBaseUrl);
  }

  const communityDocs = await collectCommunityThreads({
    communityMaxThreadsPerForum: communityMax
  });

  const knowledgeDocs = await collectKnowledgeCatalog({
    knowledgeMaxArticles: knowledgeMax,
    kbToken,
    kbBaseUrl: options.kbBaseUrl ?? process.env.SANGFOR_KB_BASE_URL ?? 'https://knowledgebase.sangfor.com'
  });

  const all: CollectedDocument[] = [...knowledgeDocs, ...communityDocs];
  saveCollectedManifest(all, manifestPath);
  const paths = saveCollectedDocuments(all, rawDir);

  let ingestedChunks = 0;
  let skippedNoProduct = 0;
  for (const path of paths) {
    const product = resolveDocumentProduct(readFileSync(path, 'utf8'));
    if (!product) {
      // Honest metrics over coverage: do not fabricate an HCI attribution.
      console.warn(`[learn-pipeline] no product header in ${path}; skipping ingest to avoid false attribution`);
      skippedNoProduct += 1;
      continue;
    }
    const result = await options.ingestDocumentFn({
      filePath: path,
      product,
      indexPath: ragIndexPath,
      sourceType: 'manual',
      trustLevel: path.includes('community') ? 'internal' : 'official',
      title: path.split('/').pop()?.replace('.md', '')
    });
    ingestedChunks += result.chunkCount;
  }

  let demoDocsIngested = 0;
  if (includeDemo) {
    for (const demo of listDemoDocTargets()) {
      const result = await options.ingestDocumentFn({
        filePath: demo.filePath,
        product: demo.product,
        version: demo.version,
        indexPath: ragIndexPath,
        sourceType: 'manual',
        trustLevel: 'official',
        title: demo.title
      });
      ingestedChunks += result.chunkCount;
      demoDocsIngested += 1;
    }
  }

  const byProduct = all.reduce<Record<string, number>>((acc, d) => {
    acc[d.product] = (acc[d.product] ?? 0) + 1;
    return acc;
  }, {});

  const finetuneSource = fineTuneCap === undefined ? all : all.slice(0, fineTuneCap);
  const finetuneExamples = docsToFineTuneExamples(
    finetuneSource.length ? finetuneSource : all.slice(0, 80)
  );
  const dataset = options.createFineTuneDatasetFn({
    product: 'HCI',
    taskType: 'lesson_extraction',
    outputPath: finetunePath,
    examples: finetuneExamples
  });
  const validation = options.validateFineTuneDatasetFn(dataset.path);

  return {
    collected: all.length,
    community: communityDocs.length,
    knowledge: knowledgeDocs.length,
    demoDocsIngested,
    auth: {
      sources: tokens.sources,
      oneAccessToken: Boolean(tokens.oneAccessToken),
      kbToken: Boolean(kbToken)
    },
    kbTokenUsed: Boolean(kbToken),
    byProduct,
    rawFiles: paths.length,
    ingestedChunks,
    rag: options.exportRagSummaryFn(ragIndexPath),
    finetune: { path: dataset.path, count: dataset.count, validation },
    oneSession
  };
}
