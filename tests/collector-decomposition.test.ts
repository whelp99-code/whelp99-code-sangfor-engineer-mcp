import { readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const SOURCE_DIR = join(ROOT, 'packages', 'sangfor-collector', 'src');
const ENTRY_MODULES = ['index.ts', 'site-learning-crawler.ts'] as const;
const FOCUSED_MODULE_PREFIXES = ['collector-', 'site-learning-'] as const;
const CRAWLER_API_LEDGER = [
  'SiteCrawlStats', 'SiteLearningCheckpoint', 'SiteLearningDocument', 'SiteLearningOptions',
  'SiteLearningReport', 'SiteLearningRunResult', 'SiteLearningValidation', 'SupportCase',
  'SupportLeaf', 'SupportProductVersion', 'SupportShowcaseRow', 'createSiteLearningCheckpoint',
  'deriveFrontierStatus', 'extractCommunityForumIds', 'extractCommunityForumPageCount',
  'extractCommunityPageCount', 'extractCommunityThreadIds', 'extractCommunityThreadPageCount',
  'flattenSupportLeaves', 'inferLearningProduct', 'isDocumentFineTuneEligible',
  'isFineTuneEligibleLearningText', 'isUrlAllowedByRobots', 'normalizeLearningText',
  'parseCommunityThreadPage', 'parseRobotsDisallowRules', 'parseSupportCasePage',
  'parseSupportProductVersions', 'parseSupportShowcaseRows', 'prepareLearningTextForFineTune',
  'redactLearningSensitiveData', 'resolveSafeCrawlUserDataDir', 'restoreSiteLearningCheckpoint',
  'runTwoSiteLearning', 'selectSupportProductVersions', 'sliceToOptionalLimit',
  'validateSiteLearningReport',
].sort();
const PACKAGE_API_LEDGER = [
  'CAPTURE_BUNDLE_MAX_BYTES', 'CAPTURE_BUNDLE_VERSION', 'CAPTURE_DEFAULT_RETENTION_MS',
  'CAPTURE_EVENT_MAX_COUNT', 'CAPTURE_ITEM_MAX_BYTES', 'CaptureBundle', 'CaptureBundleKeys',
  'CaptureBundleMetadata', 'CaptureBundleSummary', 'CaptureKeyring', 'CollectOptions',
  'CollectedDocument', 'DEMO_DOCS_DIR', 'DEMO_DOC_PRODUCTS', 'KbNavArticle', 'LEARNING_SITES',
  'LearningSite', 'LearningSiteId', 'LearningUrlClassification', 'PromoteCaptureInput',
  'REDACTION_PATTERNS', 'SiteCrawlStats', 'SiteLearningCheckpoint', 'SiteLearningDocument',
  'SiteLearningOptions', 'SiteLearningReport', 'SiteLearningRunResult', 'SiteLearningValidation',
  'SourceKind', 'SupportCase', 'SupportLeaf', 'SupportProductVersion', 'SupportShowcaseRow',
  'canonicalizeLearningUrl', 'captureKeyringFromEnv', 'catalogStubMarkdown',
  'classifyLearningUrl', 'collectCommunityThreads', 'collectKnowledgeCatalog',
  'computeDeviceScopeDigest', 'containsSensitiveData', 'contentHash',
  'createSiteLearningCheckpoint', 'decryptCaptureBundle', 'decryptCaptureBundleWithKeyring',
  'deriveFrontierStatus', 'docsToFineTuneExamples', 'encryptCaptureBundle',
  'exchangeOneOAuthCode', 'extractCommunityForumIds', 'extractCommunityForumPageCount',
  'extractCommunityPageCount', 'extractCommunityThreadIds', 'extractCommunityThreadPageCount',
  'fetchKbArticleMarkdown', 'fetchText', 'flattenSupportLeaves', 'generateCaptureBundleKeys',
  'htmlToText', 'inferLearningProduct', 'inferProductFromText', 'isCommunityNoise',
  'isDocumentFineTuneEligible', 'isFineTuneEligibleLearningText', 'isUrlAllowedByRobots',
  'isUsefulLearningText', 'listDemoDocTargets', 'loadCollectedManifest', 'loadEnvFile',
  'loadOneSessionFromEnv', 'normalizeLearningText', 'parseCaptureKeyring',
  'parseCollectionLimit', 'parseCommunityThread', 'parseCommunityThreadIds',
  'parseCommunityThreadPage', 'parseKbCategoryNavigation', 'parseRobotsDisallowRules',
  'parseSupportCasePage', 'parseSupportProductVersions', 'parseSupportShowcaseRows',
  'prepareLearningTextForFineTune', 'promoteCapturePayload', 'readCaptureBundle',
  'readCapturePayload', 'redactLearningSensitiveData', 'resolveAuthTokens',
  'resolveKbTokenFromOne', 'resolveSafeCrawlUserDataDir', 'restoreSiteLearningCheckpoint',
  'runTwoSiteLearning', 'sanitizeForFineTune', 'saveCollectedDocuments',
  'saveCollectedManifest', 'selectSupportProductVersions', 'sliceToOptionalLimit',
  'validateCaptureBundle', 'validateRedactionCanary', 'validateSiteLearningReport',
  'verifyOneSession', 'writeCaptureBundle',
].sort();

function pureLoc(path: string): number {
  return readFileSync(path, 'utf8').split('\n').filter((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith('//') && !trimmed.startsWith('#');
  }).length;
}

const config = ts.readConfigFile(join(ROOT, 'tsconfig.json'), ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
const sourcePaths = readdirSync(SOURCE_DIR, { withFileTypes: true })
  .filter((entry) => entry.isFile() && ['.ts', '.tsx', '.mts', '.cts'].includes(extname(entry.name)))
  .map((entry) => join(SOURCE_DIR, entry.name));
const program = ts.createProgram(sourcePaths, parsed.options);
const checker = program.getTypeChecker();

class CompilerModuleError extends Error {
  readonly name = 'CompilerModuleError';
}

function compilerExports(relativePath: string): readonly string[] {
  const source = program.getSourceFile(join(ROOT, relativePath));
  if (!source) throw new CompilerModuleError(`Missing API ledger source: ${relativePath}`);
  const symbol = checker.getSymbolAtLocation(source);
  if (!symbol) throw new CompilerModuleError(`Missing API ledger module symbol: ${relativePath}`);
  return checker.getExportsOfModule(symbol).map(({ name }) => name).sort();
}

describe('sangfor collector decomposition', () => {
  it('Given collector facades and focused modules, When measured, Then every module stays within 250 pure LOC', () => {
    // Given
    const focusedModules = readdirSync(SOURCE_DIR)
      .filter((name) => FOCUSED_MODULE_PREFIXES.some((prefix) => name.startsWith(prefix)))
      .filter((name) => name.endsWith('.ts'));
    const modules = [...new Set([...ENTRY_MODULES, ...focusedModules])]
      .map((name) => join(SOURCE_DIR, name));

    // When
    const oversized = modules.map((path) => ({ name: basename(path), lines: pureLoc(path) }))
      .filter(({ lines }) => lines > 250);

    // Then
    expect(oversized).toEqual([]);
  });

  it('Given the 37-symbol crawler API ledger, When TypeScript resolves exports, Then it is exact', () => {
    // Given
    const expected = CRAWLER_API_LEDGER;

    // When
    const actual = compilerExports('packages/sangfor-collector/src/site-learning-crawler.ts');

    // Then
    expect(actual).toEqual(expected);
  });

  it('Given the 101-symbol package API ledger, When TypeScript resolves exports, Then it is exact', () => {
    // Given
    const expected = PACKAGE_API_LEDGER;

    // When
    const actual = compilerExports('packages/sangfor-collector/src/index.ts');

    // Then
    expect(actual).toEqual(expected);
  });
});
