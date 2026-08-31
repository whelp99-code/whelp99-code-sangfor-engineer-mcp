import { LEARNING_SITES, canonicalizeLearningUrl } from './learning-sites.js';
import { delay, navigateAndExtract } from './site-learning-browser.js';
import { acceptDocument, inferLearningProduct } from './site-learning-content.js';
import { flattenSupportLeaves } from './site-learning-support-parsers.js';
import type { SupportCrawlContext } from './site-learning-support-context.js';
import type { SupportLeaf, SupportTreeNode } from './site-learning-types.js';
import { SUPPORT_BASE } from './site-learning-types.js';

export async function crawlSupportManuals(context: SupportCrawlContext): Promise<void> {
  const { page, state, options, seenDocumentUrls, supportLimitReached } = context;
  const site = LEARNING_SITES[0];

  for (const version of options.includeSupportManuals === false ? [] : context.versions) {
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
    } catch { // no-excuse-ok: catch
      // Preserve the original API-only fallback when navigation is destroyed mid-evaluate.
    }
    const rootIds = rootCategoryIds.length ? rootCategoryIds : fallbackCategoryIds;

    for (const rootCategoryId of [...new Set(rootIds)]) {
      let leaves: SupportLeaf[] = [];
      try {
        const treeResponse = await page.request.get(
          `${SUPPORT_BASE}/ProductDocument/leftCategories?product_id=${version.productId}`
          + `&doc_type=1&category_id=${rootCategoryId}&version_id=${version.versionId}`,
          { timeout: 60_000 },
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
          + `&version_id=${version.versionId}&category_id=${leaf.categoryId}&type=1`,
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
            product: inferLearningProduct(version.productName),
            title: `${version.productName} ${version.versionName} - ${leaf.path.join(' / ')}`,
            text: extracted.text,
            fetchedAt: new Date().toISOString(),
          }, state.support);
          if (state.support.accepted > 0 && state.support.accepted % 25 === 0) {
            console.error(
              `[two-site-learning] support accepted ${state.support.accepted}`
              + ` / discovered ${state.support.discovered}`,
            );
          }
        } catch {
          state.support.errors += 1;
        }
        await delay(options.delayMs);
      }
    }
  }
}
