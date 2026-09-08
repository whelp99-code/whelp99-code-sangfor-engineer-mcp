/**
 * The types shared across the KB browser session modules: the tokens that
 * authenticate a session and the browser handle a launcher hands back.
 *
 * They live apart from the modules that produce them so the launcher, the page
 * driver, and the lifecycle scope can depend on the shape without depending on
 * each other.
 */
import type { Browser, BrowserContext, Page } from 'playwright';

export interface KbBrowserTokens {
  libraryToken: string;
  tokenByCode: string;
  oneAccessToken?: string;
}

export interface KbBrowserHandle {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  close: () => Promise<void>;
}

export type KbBrowserLauncher = (tokens: KbBrowserTokens) => Promise<KbBrowserHandle>;
