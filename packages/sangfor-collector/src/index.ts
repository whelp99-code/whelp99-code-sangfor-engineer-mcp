import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseBoundaryCollectorArticleDataV1,
  parseBoundaryCollectorManifestV1,
} from './runtime-boundaries.js';
import { parseKbCategoryNavigationCore } from './collector-knowledge.js';
import { collectKnowledgeCatalogCore } from './collector-sources.js';
import type {
  CollectOptions,
  CollectedDocument,
  KbNavArticle,
} from './collector-types.js';

export type {
  CollectOptions,
  CollectedDocument,
  KbNavArticle,
  SourceKind,
} from './collector-types.js';
export {
  htmlToText,
  inferProductFromText,
  isCommunityNoise,
  parseCommunityThread,
  parseCommunityThreadIds,
} from './collector-community.js';
export {
  catalogStubMarkdown,
  fetchKbArticleMarkdown,
} from './collector-knowledge.js';
export {
  collectCommunityThreads,
  fetchText,
} from './collector-sources.js';
export {
  contentHash,
  docsToFineTuneExamples,
  sanitizeForFineTune,
} from './collector-persistence.js';

export function parseKbCategoryNavigation(json: unknown, baseUrl: string): KbNavArticle[] {
  return parseKbCategoryNavigationCore(
    json,
    baseUrl,
    (source) => parseBoundaryCollectorArticleDataV1(source),
  );
}

export async function collectKnowledgeCatalog(
  options: CollectOptions = {},
): Promise<CollectedDocument[]> {
  return collectKnowledgeCatalogCore(options, parseKbCategoryNavigation);
}

export function saveCollectedDocuments(docs: CollectedDocument[], rawDir: string): string[] {
  mkdirSync(rawDir, { recursive: true });
  const paths: string[] = [];
  for (const doc of docs) {
    const safeName = doc.id.replace(/[^a-zA-Z0-9_-]/g, '_');
    const path = join(rawDir, `${safeName}.md`);
    const frontmatter = [
      '---',
      `id: ${doc.id}`,
      `source: ${doc.source}`,
      `sourceUrl: ${doc.sourceUrl}`,
      `product: ${doc.product}`,
      `trustLevel: ${doc.trustLevel}`,
      `fetchedAt: ${doc.fetchedAt}`,
      '---',
      ''
    ].join('\n');
    writeFileSync(path, `${frontmatter}${doc.text}\n`, 'utf8');
    paths.push(path);
  }
  return paths;
}

export function loadCollectedManifest(manifestPath: string): CollectedDocument[] {
  if (!existsSync(manifestPath)) return [];
  return parseBoundaryCollectorManifestV1(readFileSync(manifestPath, 'utf8'));
}

export function saveCollectedManifest(docs: CollectedDocument[], manifestPath: string): void {
  mkdirSync(manifestPath.split('/').slice(0, -1).join('/') || '.', { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(docs, null, 2));
}

export {
  loadOneSessionFromEnv,
  resolveAuthTokens,
  verifyOneSession,
  resolveKbTokenFromOne,
  exchangeOneOAuthCode,
} from './one-session.js';
export { loadEnvFile, parseCollectionLimit } from './load-env.js';
export { listDemoDocTargets, DEMO_DOCS_DIR, DEMO_DOC_PRODUCTS } from './demo-docs.js';
export * from './learning-sites.js';
export * from './site-learning-crawler.js';
export * from './capture-bundle.js';
