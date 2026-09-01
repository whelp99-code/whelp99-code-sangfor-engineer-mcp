import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseBoundaryCollectorCheckpointV1,
  parseBoundaryCollectorReportV1,
} from './runtime-boundaries.js';
import { LEARNING_SITES } from './learning-sites.js';
import { launchContext, resolveSafeCrawlUserDataDir } from './site-learning-browser.js';
import { crawlCommunity } from './site-learning-community-crawler.js';
import { parseRobotsDisallowRules } from './site-learning-community-parsers.js';
import { documentMarkdown, safeId } from './site-learning-content.js';
import {
  createSiteLearningCheckpoint,
  deriveFrontierStatus,
  emptyStats,
  validateSiteLearningReport,
} from './site-learning-report.js';
import { crawlSupport } from './site-learning-support-crawler.js';
import type {
  CrawlState,
  SiteLearningCheckpoint,
  SiteLearningOptions,
  SiteLearningRunResult,
} from './site-learning-types.js';
import {
  DEFAULT_CHECKPOINT_PATH,
  DEFAULT_RAW_DIR,
  DEFAULT_REPORT_PATH,
} from './site-learning-types.js';

export type {
  SiteCrawlStats, SiteLearningCheckpoint, SiteLearningDocument, SiteLearningOptions,
  SiteLearningReport, SiteLearningRunResult, SiteLearningValidation, SupportCase,
  SupportLeaf, SupportProductVersion, SupportShowcaseRow,
} from './site-learning-types.js';
export { createSiteLearningCheckpoint, deriveFrontierStatus, validateSiteLearningReport };
export {
  flattenSupportLeaves, parseSupportCasePage, parseSupportProductVersions,
  parseSupportShowcaseRows, selectSupportProductVersions, sliceToOptionalLimit,
} from './site-learning-support-parsers.js';
export {
  extractCommunityForumIds, extractCommunityForumPageCount, extractCommunityPageCount,
  extractCommunityThreadIds, extractCommunityThreadPageCount, isUrlAllowedByRobots,
  parseCommunityThreadPage, parseRobotsDisallowRules,
} from './site-learning-community-parsers.js';
export {
  inferLearningProduct, isDocumentFineTuneEligible, isFineTuneEligibleLearningText,
  normalizeLearningText, prepareLearningTextForFineTune, redactLearningSensitiveData,
} from './site-learning-content.js';
export { resolveSafeCrawlUserDataDir };

class InvalidSiteLearningCheckpointError extends Error {
  readonly name = 'InvalidSiteLearningCheckpointError';

  constructor(options: ErrorOptions) {
    super('INVALID_TWO_SITE_CHECKPOINT', options);
  }
}

export function restoreSiteLearningCheckpoint(raw: string): SiteLearningCheckpoint {
  try {
    return parseBoundaryCollectorCheckpointV1(raw);
  } catch (error) {
    throw new InvalidSiteLearningCheckpointError({ cause: error });
  }
}

function saveCheckpoint(path: string, state: CrawlState, completed: boolean): void {
  writeFileSync(path, JSON.stringify(createSiteLearningCheckpoint({
    completed,
    documents: state.documents,
    support: state.support,
    community: state.community,
    limitState: state.limitState
  }), null, 2), 'utf8');
}

export async function runTwoSiteLearning(options: SiteLearningOptions = {}): Promise<SiteLearningRunResult> {
  const rawDir = options.rawDir ?? DEFAULT_RAW_DIR;
  const reportPath = options.reportPath ?? DEFAULT_REPORT_PATH;
  const checkpointPath = options.checkpointPath ?? DEFAULT_CHECKPOINT_PATH;
  const startedAt = new Date().toISOString();
  const state: CrawlState = {
    documents: [],
    seenHashes: new Set<string>(),
    support: emptyStats(),
    community: emptyStats()
    ,
    limitState: {
      supportLimitReached: false,
      communityForumLimitApplied: false,
      communityPageLimitApplied: false,
      communityThreadLimitApplied: false
    },
    robots: {},
    persist: undefined
  };
  mkdirSync(rawDir, { recursive: true });
  mkdirSync(join(reportPath, '..'), { recursive: true });
  if (existsSync(checkpointPath)) {
    const checkpoint = restoreSiteLearningCheckpoint(readFileSync(checkpointPath, 'utf8'));
    state.documents = checkpoint.documents;
    state.support = checkpoint.support;
    state.community = checkpoint.community;
    state.limitState = checkpoint.limitState;
    for (const hash of checkpoint.contentHashes) state.seenHashes.add(hash);
    if (checkpoint.completed) {
      const report = parseBoundaryCollectorReportV1(readFileSync(reportPath, 'utf8'));
      const files = checkpoint.documents.map((document) =>
        join(rawDir, `${safeId(document.id)}.md`));
      return { report, documents: checkpoint.documents, files };
    }
  }
  state.persist = () => saveCheckpoint(checkpointPath, state, false);

  const context = await launchContext(options);
  try {
    const pages = context.pages();
    const page = pages[0] ?? await context.newPage();
    const effective = { ...options, delayMs: options.delayMs ?? 350 };
    for (const site of LEARNING_SITES) {
      try {
        const robotsUrl = `https://${site.host}/robots.txt`;
        const response = await page.request.get(robotsUrl, { timeout: 60_000 });
        if (!response.ok()) throw new Error(`robots status ${response.status()}`);
        state.robots[site.id] = parseRobotsDisallowRules(await response.text());
      } catch (error) {
        throw new Error(`ROBOTS_FETCH_FAILED: ${site.host}: ${String(error)}`);
      }
    }
    await crawlSupport(page, state, effective);
    saveCheckpoint(checkpointPath, state, false);
    await crawlCommunity(page, state, effective);
    saveCheckpoint(checkpointPath, state, false);
  } finally {
    await context.close();
  }

  const files = state.documents.map((document) => {
    const path = join(rawDir, `${safeId(document.id)}.md`);
    writeFileSync(path, documentMarkdown(document), 'utf8');
    return path;
  });
  const frontier = deriveFrontierStatus(state.limitState);
  const report = {
    startedAt,
    completedAt: new Date().toISOString(),
    sourceRoots: LEARNING_SITES.map((site) => site.rootUrl),
    support: state.support,
    community: state.community,
    documents: state.documents.length,
    ...frontier
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  saveCheckpoint(checkpointPath, state, true);
  return { report, documents: state.documents, files };
}
