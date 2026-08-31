import type { Page } from 'playwright';
import { createSupportCrawlContext } from './site-learning-support-context.js';
import { crawlSupportManuals } from './site-learning-support-manuals.js';
import {
  crawlSupportCases,
  crawlSupportPractices,
  crawlSupportRootPages,
  loadSupportShowcase,
} from './site-learning-support-showcase.js';
import type { CrawlState, EffectiveSiteLearningOptions } from './site-learning-types.js';

export async function crawlSupport(
  page: Page,
  state: CrawlState,
  options: EffectiveSiteLearningOptions,
): Promise<void> {
  const context = await createSupportCrawlContext(page, state, options);
  await crawlSupportManuals(context);
  const showcase = await loadSupportShowcase(context);
  await crawlSupportPractices(context, showcase.get('BEST_PRACTICES') ?? []);
  await crawlSupportCases(context, showcase.get('TROUBLESHOOTING_CASES') ?? []);
  await crawlSupportRootPages(context);
  state.limitState.supportLimitReached = context.supportLimitReached();
}
