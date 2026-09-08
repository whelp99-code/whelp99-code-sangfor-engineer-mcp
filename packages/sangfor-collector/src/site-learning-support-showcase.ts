import { LEARNING_SITES, canonicalizeLearningUrl, classifyLearningUrl } from './learning-sites.js';
import { delay, navigateAndExtract } from './site-learning-browser.js';
import { acceptDocument, inferLearningProduct, safeId } from './site-learning-content.js';
import type { SupportCrawlContext } from './site-learning-support-context.js';
import { parseSupportCasePage, parseSupportShowcaseRows } from './site-learning-support-parsers.js';
import type { SupportShowcaseRow } from './site-learning-types.js';
import { SUPPORT_BASE } from './site-learning-types.js';

export async function loadSupportShowcase(
  context: SupportCrawlContext,
): Promise<ReadonlyMap<string, SupportShowcaseRow[]>> {
  const showcase = new Map<string, SupportShowcaseRow[]>();
  for (const code of ['TROUBLESHOOTING_CASES', 'BEST_PRACTICES']) {
    try {
      const response = await context.page.request.get(
        `${SUPPORT_BASE}/spt/openapi/showcaseContent/getShowcaseContentListByCode?code=${code}`,
        { timeout: 60_000 },
      );
      showcase.set(code, parseSupportShowcaseRows(await response.json()));
    } catch {
      context.state.support.errors += 1;
    }
  }
  return showcase;
}

export async function crawlSupportPractices(
  context: SupportCrawlContext,
  rows: readonly SupportShowcaseRow[],
): Promise<void> {
  const { page, state, options, seenDocumentUrls, supportLimitReached } = context;
  const site = LEARNING_SITES[0];
  for (const row of options.includeSupportPractices === false ? [] : rows) {
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
            fetchedAt: new Date().toISOString(),
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
}

export async function crawlSupportCases(
  context: SupportCrawlContext,
  rows: readonly SupportShowcaseRow[],
): Promise<void> {
  const { page, state, options, productNames, supportLimitReached } = context;
  const site = LEARNING_SITES[0];
  for (const row of options.includeSupportCases === false ? [] : rows) {
    if (supportLimitReached()) break;
    const productId = Number(new URL(row.linkUrl, SUPPORT_BASE).searchParams.get('product_id'));
    if (!Number.isInteger(productId)) continue;
    let pageNumber = 0;
    let totalPages = 1;
    do {
      state.support.discovered += 1;
      try {
        const response = await page.request.post(`${SUPPORT_BASE}/spt/openapi/case/es/search`, {
          data: {
            childModuleIds: [], keyword: '', mainModuleIds: [],
            productLineId: String(productId), versionId: '', pageNum: pageNumber, pageSize: 100,
          },
          timeout: 60_000,
        });
        const parsed = parseSupportCasePage(await response.json());
        totalPages = parsed.totalPages;
        state.support.fetched += 1;
        for (const supportCase of parsed.cases) {
          if (supportLimitReached()) break;
          acceptDocument(state, site, {
            id: `support_case_${safeId(supportCase.id)}`,
            sourceUrl: `${SUPPORT_BASE}/cases/list?product_id=${productId}&type=1#case-${encodeURIComponent(supportCase.id)}`,
            product: inferLearningProduct(
              `${productNames.get(productId) ?? row.name} ${row.remark} ${supportCase.title}`,
            ),
            title: supportCase.title,
            text: supportCase.text,
            fetchedAt: new Date().toISOString(),
          }, state.support);
        }
      } catch {
        state.support.errors += 1;
      }
      pageNumber += 1;
      await delay(options.delayMs);
    } while (pageNumber < totalPages);
  }
}

export async function crawlSupportRootPages(context: SupportCrawlContext): Promise<void> {
  const { page, state, options, seenDocumentUrls, supportLimitReached } = context;
  const site = LEARNING_SITES[0];
  for (const rootUrl of [
    `${SUPPORT_BASE}/`,
    `${SUPPORT_BASE}/productTool`,
    `${SUPPORT_BASE}/common/protocol?type=1`,
    `${SUPPORT_BASE}/common/protocol?type=2`,
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
        fetchedAt: new Date().toISOString(),
      }, state.support);
    } catch {
      state.support.errors += 1;
    }
    await delay(options.delayMs);
  }
}
