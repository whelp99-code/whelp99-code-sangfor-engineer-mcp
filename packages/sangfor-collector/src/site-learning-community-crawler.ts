import type { Page } from 'playwright';
import { LEARNING_SITES, canonicalizeLearningUrl, classifyLearningUrl } from './learning-sites.js';
import { delay, navigateAndExtract } from './site-learning-browser.js';
import {
  extractCommunityForumIds,
  extractCommunityForumPageCount,
  extractCommunityThreadIds,
  extractCommunityThreadPageCount,
  isUrlAllowedByRobots,
  parseCommunityThreadPage,
} from './site-learning-community-parsers.js';
import { acceptDocument, increment, inferLearningProduct, safeId } from './site-learning-content.js';
import { sliceToOptionalLimit } from './site-learning-support-parsers.js';
import type { CrawlState, EffectiveSiteLearningOptions } from './site-learning-types.js';
import { COMMUNITY_BASE, DEFAULT_FORUM_IDS } from './site-learning-types.js';

async function discoverCommunityForums(page: Page): Promise<number[]> {
  const [pluginHtml, forumHtml] = await Promise.all([
    page.request.get(`${COMMUNITY_BASE}/plugin.php?id=info:index`, { timeout: 60_000 })
      .then((response) => response.text()),
    page.request.get(`${COMMUNITY_BASE}/forum.php`, { timeout: 60_000 })
      .then((response) => response.text()),
  ]);
  return [...new Set([
    ...DEFAULT_FORUM_IDS,
    ...extractCommunityForumIds(pluginHtml),
    ...extractCommunityForumIds(forumHtml),
  ])].sort((left, right) => left - right);
}

export async function crawlCommunity(
  page: Page,
  state: CrawlState,
  options: EffectiveSiteLearningOptions,
): Promise<void> {
  const site = LEARNING_SITES[1];
  const completedThreadIds = new Set(
    state.documents.flatMap((document) => {
      const match = document.id.match(/^community_thread_(\d+)$/);
      return match ? [Number(match[1])] : [];
    }),
  );
  const forumIds = sliceToOptionalLimit(
    await discoverCommunityForums(page),
    options.maxCommunityForums,
  );
  state.limitState.communityForumLimitApplied = options.maxCommunityForums !== undefined
    && forumIds.length === options.maxCommunityForums;
  const threadIds = new Set<number>();

  for (const forumId of forumIds) {
    const firstUrl = `${COMMUNITY_BASE}/forum.php?mod=forumdisplay&fid=${forumId}&page=1`;
    const firstHtml = await page.request.get(firstUrl, { timeout: 60_000 })
      .then((response) => response.text());
    const discoveredLastPage = extractCommunityForumPageCount(firstHtml, forumId);
    const lastPage = Math.min(discoveredLastPage, options.maxCommunityPagesPerForum ?? Infinity);
    if (options.maxCommunityPagesPerForum !== undefined && discoveredLastPage > lastPage) {
      state.limitState.communityPageLimitApplied = true;
    }
    for (let pageNumber = 1; pageNumber <= lastPage; pageNumber += 1) {
      const url = `${COMMUNITY_BASE}/forum.php?mod=forumdisplay&fid=${forumId}&page=${pageNumber}`;
      const classification = classifyLearningUrl(url);
      const robotsAllowed = isUrlAllowedByRobots(url, state.robots.sangfor_community ?? []);
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
      const firstHtml = await page.request.get(firstUrl, { timeout: 60_000 })
        .then((response) => response.text());
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
        fetchedAt: new Date().toISOString(),
      }, state.community);
      if (state.community.accepted > 0 && state.community.accepted % 25 === 0) {
        console.error(
          `[two-site-learning] community accepted ${state.community.accepted}`
          + ` / discovered ${state.community.discovered}`,
        );
      }
    } catch {
      state.community.errors += 1;
    }
  }

  await crawlCommunityPlugins(page, state);
}

async function crawlCommunityPlugins(page: Page, state: CrawlState): Promise<void> {
  const site = LEARNING_SITES[1];
  for (const pluginUrl of [
    `${COMMUNITY_BASE}/plugin.php?id=info:index`,
    `${COMMUNITY_BASE}/plugin.php?id=common_plug:robotList`,
    `${COMMUNITY_BASE}/plugin.php?id=service:query`,
    `${COMMUNITY_BASE}/plugin.php?id=common_plug:online`,
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
        fetchedAt: new Date().toISOString(),
      }, state.community);
    } catch {
      state.community.errors += 1;
    }
  }
}
