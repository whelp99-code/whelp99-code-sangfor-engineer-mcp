import type {
  CrawlLimitState,
  SiteCrawlStats,
  SiteLearningCheckpoint,
  SiteLearningDocument,
  SiteLearningReport,
  SiteLearningValidation,
} from './site-learning-types.js';

export function emptyStats(): SiteCrawlStats {
  return {
    discovered: 0,
    fetched: 0,
    accepted: 0,
    rejected: {},
    duplicates: 0,
    errors: 0,
  };
}

export function validateSiteLearningReport(
  report: SiteLearningReport,
): SiteLearningValidation {
  const errors: string[] = [];
  for (const [name, stats] of [
    ['support', report.support],
    ['community', report.community],
  ] as const) {
    if (stats.accepted === 0) errors.push(`${name} accepted no documents`);
    if (stats.errors > 0) errors.push(`${name} crawl has ${stats.errors} errors`);
    if (stats.fetched > stats.discovered) errors.push(`${name} fetched exceeds discovered`);
  }
  if (!report.frontierExhausted) errors.push('crawl frontier was not exhausted');
  if (report.documents !== report.support.accepted + report.community.accepted) {
    errors.push('document total does not equal accepted source totals');
  }
  return { ok: errors.length === 0, errors };
}

export function deriveFrontierStatus(limitState: CrawlLimitState): {
  frontierExhausted: boolean;
  truncatedByLimit: string[];
} {
  const truncatedByLimit = [
    limitState.supportLimitReached ? 'maxSupportDocuments' : undefined,
    limitState.communityForumLimitApplied ? 'maxCommunityForums' : undefined,
    limitState.communityPageLimitApplied ? 'maxCommunityPagesPerForum' : undefined,
    limitState.communityThreadLimitApplied ? 'maxCommunityThreads' : undefined,
  ].filter((value): value is string => value !== undefined);
  return {
    frontierExhausted: truncatedByLimit.length === 0,
    truncatedByLimit,
  };
}

export function createSiteLearningCheckpoint(input: {
  completed: boolean;
  documents: SiteLearningDocument[];
  support: SiteCrawlStats;
  community: SiteCrawlStats;
  limitState: CrawlLimitState;
}): SiteLearningCheckpoint {
  return {
    version: 1,
    completed: input.completed,
    documents: input.documents,
    contentHashes: [...new Set(input.documents.map((document) => document.contentHash))],
    support: input.support,
    community: input.community,
    limitState: input.limitState,
  };
}
