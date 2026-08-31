import type { ProductCode } from '@sangfor/shared';
import type { LearningSite, LearningSiteId } from './learning-sites.js';

export interface SupportTreeNode {
  id: number;
  name: string;
  children?: SupportTreeNode[];
}

export interface SupportShowcaseRow {
  id: number;
  code: string;
  name: string;
  linkUrl: string;
  remark: string;
}

export interface SupportCase {
  id: string;
  title: string;
  text: string;
  productId: number;
}

export interface SupportProductVersion {
  productId: number;
  productName: string;
  versionId: number;
  versionName: string;
}

export interface SupportLeaf {
  categoryId: number;
  path: string[];
}

export interface SiteLearningDocument {
  id: string;
  siteId: LearningSiteId;
  source: LearningSite['source'];
  sourceUrl: string;
  product: ProductCode;
  title: string;
  text: string;
  trustLevel: LearningSite['trustLevel'];
  fetchedAt: string;
  contentHash: string;
}

export interface SiteCrawlStats {
  discovered: number;
  fetched: number;
  accepted: number;
  rejected: Record<string, number>;
  duplicates: number;
  errors: number;
}

export interface SiteLearningReport {
  startedAt: string;
  completedAt: string;
  sourceRoots: string[];
  support: SiteCrawlStats;
  community: SiteCrawlStats;
  documents: number;
  frontierExhausted: boolean;
  truncatedByLimit: string[];
}

export interface SiteLearningValidation {
  ok: boolean;
  errors: string[];
}

export interface SiteLearningOptions {
  rawDir?: string;
  reportPath?: string;
  checkpointPath?: string;
  maxSupportVersions?: number;
  maxSupportDocuments?: number;
  maxCommunityForums?: number;
  maxCommunityPagesPerForum?: number;
  maxCommunityThreads?: number;
  includeSupportManuals?: boolean;
  includeSupportPractices?: boolean;
  includeSupportCases?: boolean;
  delayMs?: number;
  browserExecutablePath?: string;
  userDataDir?: string;
}

export interface SiteLearningRunResult {
  report: SiteLearningReport;
  documents: SiteLearningDocument[];
  files: string[];
}

export interface CrawlLimitState {
  supportLimitReached: boolean;
  communityForumLimitApplied: boolean;
  communityPageLimitApplied: boolean;
  communityThreadLimitApplied: boolean;
}

export interface CrawlState {
  documents: SiteLearningDocument[];
  seenHashes: Set<string>;
  support: SiteCrawlStats;
  community: SiteCrawlStats;
  limitState: CrawlLimitState;
  robots: Partial<Record<LearningSiteId, string[]>>;
  persist?: () => void;
}

export interface SiteLearningCheckpoint {
  version: 1;
  completed: boolean;
  documents: SiteLearningDocument[];
  contentHashes: string[];
  support: SiteCrawlStats;
  community: SiteCrawlStats;
  limitState: CrawlLimitState;
}

export type EffectiveSiteLearningOptions = SiteLearningOptions & { delayMs: number };

export const SUPPORT_BASE = 'https://support.sangfor.com';
export const COMMUNITY_BASE = 'https://community.sangfor.com';
export const DEFAULT_RAW_DIR = 'data/sources/raw';
export const DEFAULT_REPORT_PATH = 'data/sources/two-site-learning-report.json';
export const DEFAULT_CHECKPOINT_PATH = 'data/sources/two-site-learning-checkpoint.json';
export const DEFAULT_FORUM_IDS = [
  8, 9, 10, 47, 89, 92, 125, 128, 136, 137, 138, 139, 143, 144, 149, 150, 151,
  156, 157, 158, 159, 160, 164, 165, 167,
] as const;
