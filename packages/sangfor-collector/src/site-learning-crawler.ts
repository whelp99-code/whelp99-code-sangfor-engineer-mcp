import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright';
import type { ProductCode } from '@sangfor/shared';
import { PRODUCTS, containsSensitiveLearningTopic } from '@sangfor/shared';
import {
  LEARNING_SITES,
  canonicalizeLearningUrl,
  classifyLearningUrl,
  isUsefulLearningText,
  type LearningSite,
  type LearningSiteId
} from './learning-sites.js';

interface SupportTreeNode {
  id: number;
  name: string;
  children?: SupportTreeNode[];
}

interface SupportVersionRecord {
  id: number;
  name: string;
  product_id: number;
}

interface SupportProductRecord {
  id: number;
  name: string;
  version: SupportVersionRecord[];
}

interface SupportProductResponse {
  code?: number;
  data?: Record<string, SupportProductRecord>;
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

interface CrawlState {
  documents: SiteLearningDocument[];
  seenHashes: Set<string>;
  support: SiteCrawlStats;
  community: SiteCrawlStats;
  limitState: {
    supportLimitReached: boolean;
    communityForumLimitApplied: boolean;
    communityPageLimitApplied: boolean;
    communityThreadLimitApplied: boolean;
  };
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
  limitState: CrawlState['limitState'];
}

const SUPPORT_BASE = 'https://support.sangfor.com';
const COMMUNITY_BASE = 'https://community.sangfor.com';
const DEFAULT_RAW_DIR = 'data/sources/raw';
const DEFAULT_REPORT_PATH = 'data/sources/two-site-learning-report.json';
const DEFAULT_CHECKPOINT_PATH = 'data/sources/two-site-learning-checkpoint.json';
const DEFAULT_FORUM_IDS = [
  8, 9, 10, 47, 89, 92, 125, 128, 136, 137, 138, 139, 143, 144, 149, 150, 151,
  156, 157, 158, 159, 160, 164, 165, 167
] as const;

const emptyStats = (): SiteCrawlStats => ({
  discovered: 0,
  fetched: 0,
  accepted: 0,
  rejected: {},
  duplicates: 0,
  errors: 0
});

export function validateSiteLearningReport(report: SiteLearningReport): SiteLearningValidation {
  const errors: string[] = [];
  for (const [name, stats] of [
    ['support', report.support],
    ['community', report.community]
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

export function deriveFrontierStatus(limitState: CrawlState['limitState']): {
  frontierExhausted: boolean;
  truncatedByLimit: string[];
} {
  const truncatedByLimit = [
    limitState.supportLimitReached ? 'maxSupportDocuments' : undefined,
    limitState.communityForumLimitApplied ? 'maxCommunityForums' : undefined,
    limitState.communityPageLimitApplied ? 'maxCommunityPagesPerForum' : undefined,
    limitState.communityThreadLimitApplied ? 'maxCommunityThreads' : undefined
  ].filter((value): value is string => value !== undefined);
  return {
    frontierExhausted: truncatedByLimit.length === 0,
    truncatedByLimit
  };
}

const increment = (values: Record<string, number>, key: string): void => {
  values[key] = (values[key] ?? 0) + 1;
};

export function createSiteLearningCheckpoint(input: {
  completed: boolean;
  documents: SiteLearningDocument[];
  support: SiteCrawlStats;
  community: SiteCrawlStats;
  limitState: CrawlState['limitState'];
}): SiteLearningCheckpoint {
  return {
    version: 1,
    completed: input.completed,
    documents: input.documents,
    contentHashes: [...new Set(input.documents.map((document) => document.contentHash))],
    support: input.support,
    community: input.community,
    limitState: input.limitState
  };
}

export function restoreSiteLearningCheckpoint(raw: string): SiteLearningCheckpoint {
  try {
    const value = JSON.parse(raw) as Partial<SiteLearningCheckpoint>;
    if (value.version !== 1 || typeof value.completed !== 'boolean'
      || !Array.isArray(value.documents) || !Array.isArray(value.contentHashes)
      || !value.support || !value.community || !value.limitState) {
      throw new Error('shape');
    }
    return value as SiteLearningCheckpoint;
  } catch {
    throw new Error('INVALID_TWO_SITE_CHECKPOINT');
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

const delay = async (milliseconds: number): Promise<void> => {
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
};

export function parseSupportProductVersions(value: unknown): SupportProductVersion[] {
  if (!value || typeof value !== 'object') return [];
  const response = value as SupportProductResponse;
  if (!response.data || typeof response.data !== 'object') return [];
  return Object.values(response.data).flatMap((product) => {
    if (!Number.isInteger(product.id) || !product.name || !Array.isArray(product.version)) return [];
    return product.version
      .filter((version) =>
        Number.isInteger(version.id)
        && Number.isInteger(version.product_id)
        && version.product_id === product.id
        && Boolean(version.name))
      .map((version) => ({
        productId: product.id,
        productName: product.name,
        versionId: version.id,
        versionName: version.name
      }));
  });
}

export function selectSupportProductVersions(
  versions: SupportProductVersion[]
): SupportProductVersion[] {
  return versions.filter((version) => !/^\s*all versions?\s*$/i.test(version.versionName));
}

export function sliceToOptionalLimit<T>(values: T[], limit: number | undefined): T[] {
  return limit === undefined ? values : values.slice(0, limit);
}

export function resolveSafeCrawlUserDataDir(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const requested = resolve(value);
  const temporaryRoot = resolve(tmpdir());
  const allowed = requested === temporaryRoot || requested.startsWith(`${temporaryRoot}/`);
  if (!allowed) throw new Error(`TWO_SITE_PROFILE_NOT_ISOLATED: ${requested}`);
  return requested;
}

export function flattenSupportLeaves(
  nodes: SupportTreeNode[],
  trail: string[] = []
): SupportLeaf[] {
  return nodes.flatMap((node) => {
    const path = [...trail, node.name];
    return node.children?.length
      ? flattenSupportLeaves(node.children, path)
      : [{ categoryId: node.id, path }];
  });
}

export function parseSupportShowcaseRows(value: unknown): SupportShowcaseRow[] {
  if (!value || typeof value !== 'object') return [];
  const rows = (value as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    const record = row as Record<string, unknown>;
    if (!Number.isInteger(record.id) || typeof record.code !== 'string'
      || typeof record.name !== 'string' || typeof record.linkUrl !== 'string') return [];
    return [{
      id: record.id as number,
      code: record.code,
      name: record.name,
      linkUrl: record.linkUrl.trim(),
      remark: typeof record.remark === 'string' ? record.remark : ''
    }];
  });
}

function stripHtml(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseSupportCasePage(value: unknown): {
  totalPages: number;
  cases: SupportCase[];
} {
  if (!value || typeof value !== 'object') return { totalPages: 0, cases: [] };
  const rows = (value as { rows?: unknown }).rows;
  if (!rows || typeof rows !== 'object') return { totalPages: 0, cases: [] };
  const record = rows as { totalPages?: unknown; content?: unknown };
  const totalPages = Number(record.totalPages);
  const content = Array.isArray(record.content) ? record.content : [];
  const cases = content.flatMap((item): SupportCase[] => {
    if (!item || typeof item !== 'object') return [];
    const entry = item as Record<string, unknown>;
    if (typeof entry.id !== 'string' || typeof entry.title !== 'string'
      || typeof entry.content !== 'string') return [];
    const productId = Number(entry.product);
    if (!Number.isInteger(productId)) return [];
    return [{
      id: entry.id,
      title: stripHtml(entry.title),
      text: stripHtml(entry.content),
      productId
    }];
  });
  return { totalPages: Number.isInteger(totalPages) && totalPages >= 0 ? totalPages : 0, cases };
}

function numericMatches(html: string, patterns: RegExp[]): number[] {
  const values = patterns.flatMap((pattern) =>
    [...html.matchAll(pattern)].map((match) => Number(match[1])));
  return [...new Set(values.filter(Number.isInteger))].sort((left, right) => left - right);
}

export function extractCommunityForumIds(html: string): number[] {
  return numericMatches(html, [
    /forum\.php\?[^"'<>]*\bfid=(\d+)/gi,
    /forum-(\d+)-\d+\.html/gi
  ]);
}

export function extractCommunityThreadIds(html: string): number[] {
  return numericMatches(html, [
    /forum\.php\?[^"'<>]*\btid=(\d+)/gi,
    /thread-(\d+)-\d+-\d+\.html/gi
  ]);
}

export function parseCommunityThreadPage(html: string): { title: string; text: string } | null {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = stripHtml(titleMatch?.[1] ?? 'Sangfor Community thread');
  const bodyPattern = /<(?:td|div)[^>]*(?:class=["'][^"']*\bt_f\b[^"']*["'][^>]*id=["']postmessage_\d+["']|id=["']postmessage_\d+["'][^>]*class=["'][^"']*\bt_f\b[^"']*["'])[^>]*>([\s\S]*?)<\/(?:td|div)>/gi;
  const bodies = [...html.matchAll(bodyPattern)]
    .map((match) => stripHtml(match[1]))
    .filter((body) => body.length > 0);
  if (bodies.length > 0) return { title, text: bodies.join('\n\n') };

  // Some Discuz threads (viewthread module) render posts entirely client-side via
  // angular.module('viewthread').value('postlistData', {...}) instead of emitting
  // <td class="t_f" id="postmessage_N"> markup. A static fetch of these pages never
  // matches the classic pattern above, which would silently drop real thread content.
  // The post bodies are still present as escaped JSON string literals in a
  // postlistData JS blob, so extract and unescape them as a fallback.
  const postlistDataStart = html.indexOf("postlistData'");
  const jsonScope = postlistDataStart >= 0 ? html.slice(postlistDataStart) : '';
  const jsonBodies = [...jsonScope.matchAll(/"message":"((?:[^"\\]|\\.)*)"/g)]
    .map((match) => {
      try {
        return stripHtml(JSON.parse(`"${match[1]}"`));
      } catch {
        return '';
      }
    })
    .filter((body) => body.length > 0);
  if (jsonBodies.length === 0) return null;
  return { title, text: jsonBodies.join('\n\n') };
}

export function parseRobotsDisallowRules(text: string): string[] {
  const rules: string[] = [];
  let applies = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const [rawName, ...rawValue] = line.split(':');
    const name = rawName.trim().toLowerCase();
    const value = rawValue.join(':').trim();
    if (name === 'user-agent') {
      applies = value === '*';
    } else if (name === 'disallow' && applies && value) {
      rules.push(value);
    }
  }
  return rules;
}

export function isUrlAllowedByRobots(rawUrl: string, disallowRules: string[]): boolean {
  const url = new URL(rawUrl);
  const pathAndQuery = `${url.pathname}${url.search}`;
  return !disallowRules.some((rule) => {
    const anchored = rule.endsWith('$');
    const body = anchored ? rule.slice(0, -1) : rule;
    const source = body
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    return new RegExp(`^${source}${anchored ? '$' : ''}`).test(pathAndQuery);
  });
}

export function extractCommunityPageCount(html: string): number {
  const pages = numericMatches(html, [
    /[?&](?:amp;)?page=(\d+)/gi,
    /(?:forum|thread)-\d+-(\d+)(?:-\d+)?\.html/gi
  ]);
  return Math.max(1, ...pages);
}

function scopedDiscuzPageCount(
  html: string,
  mode: 'forumdisplay' | 'viewthread',
  idName: 'fid' | 'tid',
  id: number
): number {
  const hrefs = [...html.matchAll(/href=["']([^"']+)["']/gi)]
    .map((match) => match[1].replace(/&amp;/g, '&'));
  const pages = hrefs.flatMap((href) => {
    try {
      const url = new URL(href, COMMUNITY_BASE);
      if (url.pathname !== '/forum.php') return [];
      if (url.searchParams.get('mod') !== mode) return [];
      if (Number(url.searchParams.get(idName)) !== id) return [];
      const page = Number(url.searchParams.get('page') ?? 1);
      return Number.isSafeInteger(page) && page > 0 ? [page] : [];
    } catch {
      return [];
    }
  });
  return Math.max(1, ...pages);
}

export function extractCommunityForumPageCount(html: string, forumId: number): number {
  const prettyPages = [...html.matchAll(new RegExp(`forum-${forumId}-(\\d+)\\.html`, 'gi'))]
    .map((match) => Number(match[1]))
    .filter((page) => Number.isSafeInteger(page) && page > 0);
  return Math.max(scopedDiscuzPageCount(html, 'forumdisplay', 'fid', forumId), ...prettyPages);
}

export function extractCommunityThreadPageCount(html: string, threadId: number): number {
  const prettyPages = [...html.matchAll(new RegExp(`thread-${threadId}-(\\d+)-\\d+\\.html`, 'gi'))]
    .map((match) => Number(match[1]))
    .filter((page) => Number.isSafeInteger(page) && page > 0);
  return Math.max(scopedDiscuzPageCount(html, 'viewthread', 'tid', threadId), ...prettyPages);
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 140);
}

export function inferLearningProduct(text: string): ProductCode {
  const raw = text.trim();
  const normalized = raw.toLowerCase().replace(/[\s-]+/g, '_');
  const matches = new Set<ProductCode>();
  for (const product of PRODUCTS) {
    if (product.code === 'OTHER') continue;
    if (product.code.toLowerCase() === normalized) matches.add(product.code);
    if (product.aliases.some((alias) => {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`\\b${escaped}\\b`, 'i').test(raw);
    })) matches.add(product.code);
  }
  return matches.size === 1 ? [...matches][0] : 'OTHER';
}

function productFromSupportName(name: string): ProductCode {
  return inferLearningProduct(name);
}

function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function normalizeLearningText(text: string): string {
  const paragraphs = text
    .replace(/\r/g, '')
    .split(/\n\s*\n|\n/)
    .map((value) => value.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const seen = new Set<string>();
  return paragraphs.filter((paragraph) => {
    const key = paragraph.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join('\n\n');
}

export function redactLearningSensitiveData(text: string): string {
  return text
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
    .replace(/(?<!\w)(?:\+?\d(?:[\s()-]*\d){7,})(?!\w)/g, '[REDACTED_PHONE]')
    .replace(/(\bBearer\s+)[A-Za-z0-9._~-]{20,}/gi, '$1[REDACTED_TOKEN]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_TOKEN]');
}

export function isFineTuneEligibleLearningText(text: string): boolean {
  return !containsSensitiveLearningTopic(text);
}

export function prepareLearningTextForFineTune(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length >= 40 && isFineTuneEligibleLearningText(paragraph))
    .join('\n\n');
}

/**
 * A document's TITLE is used verbatim as the fine-tune "input" prompt, separately
 * from its body (which goes through prepareLearningTextForFineTune). A title alone
 * can carry a sensitive topic word ("Reset Admin Password", "License Key Activation")
 * even when the filtered body is clean — so the title must pass the same eligibility
 * check, and the safe body must clear the minimum-length floor, before a document is
 * fine-tune eligible. Fails closed: any doubt keeps the document out of fine-tuning
 * (it remains fully available in RAG regardless).
 */
export function isDocumentFineTuneEligible(title: string, safeText: string): boolean {
  return safeText.length >= 180 && isFineTuneEligibleLearningText(title);
}

function documentMarkdown(document: SiteLearningDocument): string {
  return [
    '---',
    `id: ${document.id}`,
    `source: ${document.source}`,
    `sourceUrl: ${document.sourceUrl}`,
    `product: ${document.product}`,
    `trustLevel: ${document.trustLevel}`,
    `fetchedAt: ${document.fetchedAt}`,
    `contentHash: ${document.contentHash}`,
    '---',
    '',
    `# ${document.title}`,
    '',
    document.text
  ].join('\n');
}

function acceptDocument(
  state: CrawlState,
  site: LearningSite,
  candidate: Omit<SiteLearningDocument, 'siteId' | 'source' | 'trustLevel' | 'contentHash'>,
  stats: SiteCrawlStats
): boolean {
  if (!isUsefulLearningText(candidate.text, candidate.title)) {
    increment(stats.rejected, 'low_quality_or_login_shell');
    return false;
  }
  const cleanText = redactLearningSensitiveData(normalizeLearningText(candidate.text));
  const hash = contentHash(cleanText);
  if (state.seenHashes.has(hash)) {
    stats.duplicates += 1;
    return false;
  }
  state.seenHashes.add(hash);
  state.documents.push({
    ...candidate,
    text: cleanText,
    siteId: site.id,
    source: site.source,
    trustLevel: site.trustLevel,
    contentHash: hash
  });
  stats.accepted += 1;
  const acceptedTotal = state.support.accepted + state.community.accepted;
  if (acceptedTotal % 25 === 0) state.persist?.();
  return true;
}

async function pageText(page: Page): Promise<{ title: string; text: string; url: string }> {
  return page.evaluate(() => {
    const postBodies = [...document.querySelectorAll<HTMLElement>('[id^="postmessage_"], .t_f')]
      .map((element) => element.innerText.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    if (postBodies.length > 0) {
      const heading = document.querySelector('h1,h2,.ts h1');
      return {
        title: (heading?.textContent || document.title || location.href).replace(/\s+/g, ' ').trim(),
        text: postBodies.join('\n\n'),
        url: location.href
      };
    }
    const candidates = [
      '.doc-content',
      '.html-content',
      '.rich-text',
      '.article-detail',
      '.detail-page',
      '.t_f',
      '#postlist',
      '#ct',
      'article',
      'main',
      '#app',
      'body'
    ];
    let best: HTMLElement | null = null;
    for (const selector of candidates) {
      for (const element of document.querySelectorAll<HTMLElement>(selector)) {
        if (!best || element.innerText.length > best.innerText.length) best = element;
      }
    }
    const heading = document.querySelector('h1,h2,.article-title,.ts h1');
    return {
      title: (heading?.textContent || document.title || location.href).replace(/\s+/g, ' ').trim(),
      text: (best?.innerText || document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 100_000),
      url: location.href
    };
  });
}

async function navigateAndExtract(page: Page, url: string): Promise<ReturnType<typeof pageText>> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  return pageText(page);
}

async function crawlSupport(
  page: Page,
  state: CrawlState,
  options: Required<Pick<SiteLearningOptions, 'delayMs'>> & SiteLearningOptions
): Promise<void> {
  const site = LEARNING_SITES[0];
  const response = await page.request.post(`${SUPPORT_BASE}/product/productVersion`, {
    timeout: 60_000
  });
  const versions = sliceToOptionalLimit(
    selectSupportProductVersions(parseSupportProductVersions(await response.json())),
    options.maxSupportVersions
  );
  const productNames = new Map(
    versions.map((version) => [version.productId, version.productName])
  );
  const seenDocumentUrls = new Set(
    state.documents
      .filter((document) => document.siteId === 'sangfor_support')
      .map((document) => document.sourceUrl)
  );
  const supportLimitReached = (): boolean =>
    state.support.accepted >= (options.maxSupportDocuments ?? Infinity);

  for (const version of options.includeSupportManuals === false ? [] : versions) {
    if (supportLimitReached()) break;
    const entryUrl = `${SUPPORT_BASE}/productDocument/read?product_id=${version.productId}&version_id=${version.versionId}&type=1`;
    let rootCategoryIds: number[] = [];
    let fallbackCategoryIds: number[] = [];
    try {
      await page.goto(entryUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForTimeout(1_000);
      rootCategoryIds = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('*')]
          .flatMap((element) => {
            const value = (element as HTMLElement & {
              __vue__?: { linkTreeData?: SupportTreeNode[] };
            }).__vue__?.linkTreeData;
            return Array.isArray(value) ? value.map((node) => node.id) : [];
          })
          .filter((categoryId) => Number.isInteger(categoryId) && categoryId > 0));
      fallbackCategoryIds = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLAnchorElement>('a[href*="productDocument/read"]')]
          .filter((link) => {
            const url = new URL(link.href, location.href);
            return url.searchParams.get('product_id') === new URL(location.href).searchParams.get('product_id')
              && url.searchParams.get('version_id') === new URL(location.href).searchParams.get('version_id');
          })
          .map((link) => Number(new URL(link.href, location.href).searchParams.get('category_id')))
          .filter((categoryId) => Number.isInteger(categoryId) && categoryId > 0));
    } catch {
      // Navigation raced with a client-side redirect or was destroyed mid-evaluate.
      // Fall back to the tree API alone (rootCategoryIds/fallbackCategoryIds stay empty);
      // the per-leaf navigateAndExtract below already retries/records errors independently.
    }
    const rootIds = rootCategoryIds.length ? rootCategoryIds : fallbackCategoryIds;

    for (const rootCategoryId of [...new Set(rootIds)]) {
      let leaves: SupportLeaf[] = [];
      try {
        const treeResponse = await page.request.get(
          `${SUPPORT_BASE}/ProductDocument/leftCategories?product_id=${version.productId}`
          + `&doc_type=1&category_id=${rootCategoryId}&version_id=${version.versionId}`,
          { timeout: 60_000 }
        );
        const treePayload = await treeResponse.json() as { data?: SupportTreeNode[] };
        leaves = flattenSupportLeaves(treePayload.data ?? []);
      } catch {
        state.support.errors += 1;
      }
      if (leaves.length === 0) {
        leaves = [{ categoryId: rootCategoryId, path: [`Category ${rootCategoryId}`] }];
      }
      for (const leaf of leaves) {
        if (supportLimitReached()) break;
        const url = canonicalizeLearningUrl(
          `${SUPPORT_BASE}/productDocument/read?product_id=${version.productId}`
          + `&version_id=${version.versionId}&category_id=${leaf.categoryId}&type=1`
        );
        if (seenDocumentUrls.has(url)) continue;
        seenDocumentUrls.add(url);
        state.support.discovered += 1;
        try {
          const extracted = await navigateAndExtract(page, url);
          state.support.fetched += 1;
          acceptDocument(state, site, {
            id: `support_${version.productId}_${version.versionId}_${leaf.categoryId}`,
            sourceUrl: canonicalizeLearningUrl(extracted.url),
            product: productFromSupportName(version.productName),
            title: `${version.productName} ${version.versionName} - ${leaf.path.join(' / ')}`,
            text: extracted.text,
            fetchedAt: new Date().toISOString()
          }, state.support);
          if (state.support.accepted > 0 && state.support.accepted % 25 === 0) {
            console.error(
              `[two-site-learning] support accepted ${state.support.accepted}`
              + ` / discovered ${state.support.discovered}`
            );
          }
        } catch {
          state.support.errors += 1;
        }
        await delay(options.delayMs);
      }
    }
  }

  const showcase = new Map<string, SupportShowcaseRow[]>();
  for (const code of ['TROUBLESHOOTING_CASES', 'BEST_PRACTICES']) {
    try {
      const response = await page.request.get(
        `${SUPPORT_BASE}/spt/openapi/showcaseContent/getShowcaseContentListByCode?code=${code}`,
        { timeout: 60_000 }
      );
      showcase.set(code, parseSupportShowcaseRows(await response.json()));
    } catch {
      state.support.errors += 1;
    }
  }

  for (const row of options.includeSupportPractices === false
    ? []
    : (showcase.get('BEST_PRACTICES') ?? [])) {
    if (supportLimitReached()) break;
    const url = canonicalizeLearningUrl(new URL(row.linkUrl, SUPPORT_BASE).toString());
    state.support.discovered += 1;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForTimeout(1_000);
      const links = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLAnchorElement>('a[href*="productDocument/read"]')]
          .map((link) => link.href)
          .filter((href) => href.includes('doc_type=2') && href.includes('category_id=')));
      for (const rawLink of [...new Set(links)]) {
        if (supportLimitReached()) break;
        const detailUrl = canonicalizeLearningUrl(rawLink);
        if (seenDocumentUrls.has(detailUrl)) continue;
        seenDocumentUrls.add(detailUrl);
        state.support.discovered += 1;
        try {
          const extracted = await navigateAndExtract(page, detailUrl);
          state.support.fetched += 1;
          acceptDocument(state, site, {
            id: `support_practice_${safeId(new URL(detailUrl).searchParams.get('product_id') ?? row.id.toString())}`
              + `_${safeId(new URL(detailUrl).searchParams.get('category_id') ?? row.id.toString())}`,
            sourceUrl: canonicalizeLearningUrl(extracted.url),
            product: inferLearningProduct(`${row.name} ${row.remark}`),
            title: `${row.name} Best Practice - ${extracted.title}`,
            text: extracted.text,
            fetchedAt: new Date().toISOString()
          }, state.support);
        } catch {
          state.support.errors += 1;
        }
        await delay(options.delayMs);
      }
    } catch {
      state.support.errors += 1;
    }
  }

  for (const row of options.includeSupportCases === false
    ? []
    : (showcase.get('TROUBLESHOOTING_CASES') ?? [])) {
    if (supportLimitReached()) break;
    const productId = Number(new URL(row.linkUrl, SUPPORT_BASE).searchParams.get('product_id'));
    if (!Number.isInteger(productId)) continue;
    let pageNumber = 0;
    let totalPages = 1;
    do {
      state.support.discovered += 1;
      try {
        const response = await page.request.post(
          `${SUPPORT_BASE}/spt/openapi/case/es/search`,
          {
            data: {
              childModuleIds: [],
              keyword: '',
              mainModuleIds: [],
              productLineId: String(productId),
              versionId: '',
              pageNum: pageNumber,
              pageSize: 100
            },
            timeout: 60_000
          }
        );
        const parsed = parseSupportCasePage(await response.json());
        totalPages = parsed.totalPages;
        state.support.fetched += 1;
        for (const supportCase of parsed.cases) {
          if (supportLimitReached()) break;
          acceptDocument(state, site, {
            id: `support_case_${safeId(supportCase.id)}`,
            sourceUrl: `${SUPPORT_BASE}/cases/list?product_id=${productId}&type=1#case-${encodeURIComponent(supportCase.id)}`,
            product: inferLearningProduct(
              `${productNames.get(productId) ?? row.name} ${row.remark} ${supportCase.title}`
            ),
            title: supportCase.title,
            text: supportCase.text,
            fetchedAt: new Date().toISOString()
          }, state.support);
        }
      } catch {
        state.support.errors += 1;
      }
      pageNumber += 1;
      await delay(options.delayMs);
    } while (pageNumber < totalPages);
  }

  for (const rootUrl of [
    `${SUPPORT_BASE}/`,
    `${SUPPORT_BASE}/productTool`,
    `${SUPPORT_BASE}/common/protocol?type=1`,
    `${SUPPORT_BASE}/common/protocol?type=2`
  ]) {
    if (supportLimitReached()) break;
    const classification = classifyLearningUrl(rootUrl);
    if (!classification.allowed || seenDocumentUrls.has(rootUrl)) continue;
    state.support.discovered += 1;
    try {
      const extracted = await navigateAndExtract(page, rootUrl);
      state.support.fetched += 1;
      acceptDocument(state, site, {
        id: `support_page_${safeId(new URL(rootUrl).pathname + new URL(rootUrl).search)}`,
        sourceUrl: canonicalizeLearningUrl(extracted.url),
        product: inferLearningProduct(`${extracted.title}\n${extracted.text}`),
        title: extracted.title,
        text: extracted.text,
        fetchedAt: new Date().toISOString()
      }, state.support);
    } catch {
      state.support.errors += 1;
    }
    await delay(options.delayMs);
  }
  state.limitState.supportLimitReached = supportLimitReached();
}

async function discoverCommunityForums(page: Page): Promise<number[]> {
  const [pluginHtml, forumHtml] = await Promise.all([
    page.request.get(`${COMMUNITY_BASE}/plugin.php?id=info:index`, {
      timeout: 60_000
    }).then((response) => response.text()),
    page.request.get(`${COMMUNITY_BASE}/forum.php`, {
      timeout: 60_000
    }).then((response) => response.text())
  ]);
  return [...new Set([
    ...DEFAULT_FORUM_IDS,
    ...extractCommunityForumIds(pluginHtml),
    ...extractCommunityForumIds(forumHtml)
  ])].sort((left, right) => left - right);
}

async function crawlCommunity(
  page: Page,
  state: CrawlState,
  options: Required<Pick<SiteLearningOptions, 'delayMs'>> & SiteLearningOptions
): Promise<void> {
  const site = LEARNING_SITES[1];
  const completedThreadIds = new Set(
    state.documents.flatMap((document) => {
      const match = document.id.match(/^community_thread_(\d+)$/);
      return match ? [Number(match[1])] : [];
    })
  );
  const forumIds = sliceToOptionalLimit(
    await discoverCommunityForums(page),
    options.maxCommunityForums
  );
  state.limitState.communityForumLimitApplied = options.maxCommunityForums !== undefined
    && forumIds.length === options.maxCommunityForums;
  const threadIds = new Set<number>();

  for (const forumId of forumIds) {
    const firstUrl = `${COMMUNITY_BASE}/forum.php?mod=forumdisplay&fid=${forumId}&page=1`;
    const firstHtml = await page.request.get(firstUrl, { timeout: 60_000 }).then((response) => response.text());
    const lastPage = Math.min(
      extractCommunityForumPageCount(firstHtml, forumId),
      options.maxCommunityPagesPerForum ?? Infinity
    );
    if (options.maxCommunityPagesPerForum !== undefined
      && extractCommunityForumPageCount(firstHtml, forumId) > lastPage) {
      state.limitState.communityPageLimitApplied = true;
    }
    for (let pageNumber = 1; pageNumber <= lastPage; pageNumber += 1) {
      const url = `${COMMUNITY_BASE}/forum.php?mod=forumdisplay&fid=${forumId}&page=${pageNumber}`;
      const classification = classifyLearningUrl(url);
      const robotsAllowed = isUrlAllowedByRobots(
        url,
        state.robots.sangfor_community ?? []
      );
      if (!classification.allowed || !robotsAllowed) {
        increment(state.community.rejected, classification.reason ?? 'url_policy');
        continue;
      }
      state.community.discovered += 1;
      try {
        const html = pageNumber === 1
          ? firstHtml
          : await page.request.get(url, { timeout: 60_000 }).then((response) => response.text());
        state.community.fetched += 1;
        for (const threadId of extractCommunityThreadIds(html)) threadIds.add(threadId);
      } catch {
        state.community.errors += 1;
      }
      await delay(options.delayMs);
    }
  }

  const selectedThreadIds = sliceToOptionalLimit([...threadIds], options.maxCommunityThreads);
  state.limitState.communityThreadLimitApplied = options.maxCommunityThreads !== undefined
    && selectedThreadIds.length < threadIds.size;
  for (const threadId of selectedThreadIds) {
    if (completedThreadIds.has(threadId)) continue;
    const firstUrl = `${COMMUNITY_BASE}/forum.php?mod=viewthread&tid=${threadId}&page=1`;
    try {
      const firstHtml = await page.request.get(firstUrl, { timeout: 60_000 }).then((response) => response.text());
      const lastPage = extractCommunityThreadPageCount(firstHtml, threadId);
      const pageTexts: string[] = [];
      let title = `Community thread ${threadId}`;
      let finalUrl = firstUrl;
      for (let pageNumber = 1; pageNumber <= lastPage; pageNumber += 1) {
        const url = `${COMMUNITY_BASE}/forum.php?mod=viewthread&tid=${threadId}&page=${pageNumber}`;
        const classification = classifyLearningUrl(url);
        if (!classification.allowed) {
          increment(state.community.rejected, classification.reason ?? 'url_policy');
          continue;
        }
        state.community.discovered += 1;
        const html = pageNumber === 1
          ? firstHtml
          : await page.request.get(url, { timeout: 60_000 }).then((response) => response.text());
        const parsed = parseCommunityThreadPage(html);
        if (!parsed) {
          increment(state.community.rejected, 'missing_post_body');
          continue;
        }
        state.community.fetched += 1;
        title = parsed.title || title;
        finalUrl = url;
        pageTexts.push(parsed.text);
        await delay(options.delayMs);
      }
      const text = [...new Set(pageTexts)].join('\n\n');
      acceptDocument(state, site, {
        id: `community_thread_${threadId}`,
        sourceUrl: canonicalizeLearningUrl(finalUrl),
        product: inferLearningProduct(`${title}\n${text}`),
        title,
        text,
        fetchedAt: new Date().toISOString()
      }, state.community);
      if (state.community.accepted > 0 && state.community.accepted % 25 === 0) {
        console.error(
          `[two-site-learning] community accepted ${state.community.accepted}`
          + ` / discovered ${state.community.discovered}`
        );
      }
    } catch {
      state.community.errors += 1;
    }
  }

  for (const pluginUrl of [
    `${COMMUNITY_BASE}/plugin.php?id=info:index`,
    `${COMMUNITY_BASE}/plugin.php?id=common_plug:robotList`,
    `${COMMUNITY_BASE}/plugin.php?id=service:query`,
    `${COMMUNITY_BASE}/plugin.php?id=common_plug:online`
  ]) {
    const classification = classifyLearningUrl(pluginUrl);
    if (!classification.allowed) continue;
    state.community.discovered += 1;
    try {
      const extracted = await navigateAndExtract(page, pluginUrl);
      state.community.fetched += 1;
      acceptDocument(state, site, {
        id: `community_plugin_${safeId(new URL(pluginUrl).searchParams.get('id') ?? 'root')}`,
        sourceUrl: canonicalizeLearningUrl(extracted.url),
        product: inferLearningProduct(`${extracted.title}\n${extracted.text}`),
        title: extracted.title,
        text: extracted.text,
        fetchedAt: new Date().toISOString()
      }, state.community);
    } catch {
      state.community.errors += 1;
    }
  }
}

async function launchContext(options: SiteLearningOptions): Promise<BrowserContext> {
  const executablePath = options.browserExecutablePath?.trim();
  const userDataDir = resolveSafeCrawlUserDataDir(options.userDataDir);
  if (userDataDir) {
    return chromium.launchPersistentContext(userDataDir, {
      ...(executablePath ? { executablePath } : { channel: 'chrome' as const }),
      headless: false,
      args: ['--profile-directory=Default'],
      ignoreHTTPSErrors: true
    });
  }
  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : { channel: 'chrome' as const }),
    headless: true
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  context.on('close', () => browser.close().catch(() => {}));
  return context;
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
      const report = JSON.parse(readFileSync(reportPath, 'utf8')) as SiteLearningReport;
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
  const report: SiteLearningReport = {
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
