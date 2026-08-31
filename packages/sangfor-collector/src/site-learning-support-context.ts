import type { Page } from 'playwright';
import {
  parseSupportProductVersions,
  selectSupportProductVersions,
  sliceToOptionalLimit,
} from './site-learning-support-parsers.js';
import type {
  CrawlState,
  EffectiveSiteLearningOptions,
  SupportProductVersion,
} from './site-learning-types.js';
import { SUPPORT_BASE } from './site-learning-types.js';

export interface SupportCrawlContext {
  readonly page: Page;
  readonly state: CrawlState;
  readonly options: EffectiveSiteLearningOptions;
  readonly versions: SupportProductVersion[];
  readonly productNames: ReadonlyMap<number, string>;
  readonly seenDocumentUrls: Set<string>;
  readonly supportLimitReached: () => boolean;
}

export async function createSupportCrawlContext(
  page: Page,
  state: CrawlState,
  options: EffectiveSiteLearningOptions,
): Promise<SupportCrawlContext> {
  const response = await page.request.post(`${SUPPORT_BASE}/product/productVersion`, {
    timeout: 60_000,
  });
  const versions = sliceToOptionalLimit(
    selectSupportProductVersions(parseSupportProductVersions(await response.json())),
    options.maxSupportVersions,
  );
  return {
    page,
    state,
    options,
    versions,
    productNames: new Map(versions.map((version) => [version.productId, version.productName])),
    seenDocumentUrls: new Set(
      state.documents
        .filter((document) => document.siteId === 'sangfor_support')
        .map((document) => document.sourceUrl),
    ),
    supportLimitReached: () =>
      state.support.accepted >= (options.maxSupportDocuments ?? Infinity),
  };
}
