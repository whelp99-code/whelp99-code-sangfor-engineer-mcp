/**
 * The external runtime the KB crawl scripts depend on: the browser/token ports
 * they call, and the root they write crawl artifacts to.
 *
 * The ports are grouped so a test can drive `crawl-kb-with-storage` and
 * `learn-kb-full-site` end to end and observe exactly which effects a given
 * input reaches — in particular, that a rejected input reaches none of them.
 */
import type { Page } from 'playwright';
import {
  launchKbBrowser,
  prepareKbPage,
  resolveKbBrowserTokens,
  type KbBrowserLauncher,
  type KbBrowserTokens
} from './kb-browser-session.js';

export interface KbScriptSession {
  readonly resolveTokens: () => Promise<KbBrowserTokens>;
  readonly launch: KbBrowserLauncher;
  readonly prepare: (tokens: KbBrowserTokens, page: Page) => Promise<boolean>;
}

export const liveKbScriptSession: KbScriptSession = {
  resolveTokens: resolveKbBrowserTokens,
  launch: launchKbBrowser,
  prepare: prepareKbPage
};

/** Crawl artifact root. Cwd-relative by default, because the pnpm scripts run from the repo root. */
export function kbDataDir(): string {
  return process.env.SANGFOR_KB_DATA_DIR?.trim() || 'data/sources';
}
