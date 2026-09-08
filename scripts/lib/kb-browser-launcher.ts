/**
 * Acquisition of a KB browser handle: which Chromium to drive (existing Chrome
 * profile, an already-running CDP endpoint, or a fresh headless instance) and
 * where the reusable storage state for that browser lives.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { KbBrowserHandle } from './kb-browser-contracts.js';

const CHROME_PROFILE = process.env.CHROME_USER_DATA ?? (
  process.platform === 'darwin'
    ? `${process.env.HOME}/Library/Application Support/Google/Chrome`
    : `${process.env.HOME}/.config/google-chrome`
);

const DEFAULT_CDP_URL = 'http://127.0.0.1:9222';

export function resolveKbPersistentLaunchOptions(
  env: NodeJS.ProcessEnv = process.env
): { executablePath: string } | { channel: 'chrome' } {
  const executablePath = env.SANGFOR_CHROMIUM_PATH?.trim();
  return executablePath ? { executablePath } : { channel: 'chrome' };
}

export function kbStorageStatePath(): string {
  const repo = process.env.SANGFOR_REPO_DIR?.trim() || process.cwd();
  return join(repo, 'data/runtime/kb-storage-state.json');
}

export async function saveKbStorageState(context: BrowserContext): Promise<void> {
  const path = kbStorageStatePath();
  mkdirSync(dirname(path), { recursive: true });
  await context.storageState({ path });
}

export type KbBrowserLaunchErrorCode = 'PERSISTENT_CONTEXT_HAS_NO_BROWSER';

export class KbBrowserLaunchError extends Error {
  override readonly name = 'KbBrowserLaunchError';
  constructor(readonly code: KbBrowserLaunchErrorCode, options?: ErrorOptions) {
    super(`KB_BROWSER_LAUNCH_FAILED: ${code}`, options);
  }
}

/**
 * Binds an already-launched persistent context to the browser that owns it.
 *
 * Playwright types `BrowserContext.browser()` as nullable because a context can
 * outlive — or never have — an owning browser handle. A handle without a browser
 * cannot honour `KbBrowserHandle`, so this fails closed and releases the context
 * it was handed instead of returning a half-built handle.
 *
 * A failure to close is reported as the `cause` rather than as the thrown error:
 * it is a consequence of the launch already being broken, and the caller needs
 * the original reason. This is the same precedence `withKbBrowser` applies.
 */
export async function createKbPersistentHandle(context: BrowserContext): Promise<KbBrowserHandle> {
  const browser = context.browser();
  if (browser === null) {
    const cause = await context.close().then(() => undefined, (error: unknown) => error);
    throw new KbBrowserLaunchError('PERSISTENT_CONTEXT_HAS_NO_BROWSER', { cause });
  }
  const page = context.pages()[0] ?? await context.newPage();
  return {
    browser,
    context,
    page,
    close: async () => { await context.close(); }
  };
}

export async function createKbContextWithStorage(browser: Browser, headed: boolean): Promise<BrowserContext> {
  const statePath = kbStorageStatePath();
  const base = headed ? { viewport: null, ignoreHTTPSErrors: true } : { ignoreHTTPSErrors: true };
  if (existsSync(statePath)) {
    return browser.newContext({ ...base, storageState: statePath });
  }
  return browser.newContext(base);
}

export async function launchKbBrowser(): Promise<KbBrowserHandle> {
  const cdpUrl = (
    process.env.SANGFOR_CDP_URL?.trim()
    || (process.env.SANGFOR_GLASS_CDP_REQUIRED === '1' ? DEFAULT_CDP_URL : '')
  );
  const headed = process.env.SANGFOR_KB_HEADED === '1';
  const useChromeProfile = process.env.SANGFOR_USE_CHROME_PROFILE === '1';

  if (useChromeProfile && existsSync(CHROME_PROFILE)) {
    return createKbPersistentHandle(await chromium.launchPersistentContext(CHROME_PROFILE, {
      ...resolveKbPersistentLaunchOptions(),
      headless: false,
      args: ['--profile-directory=Default'],
      ignoreHTTPSErrors: true
    }));
  }

  if (cdpUrl) {
    const browser = await chromium.connectOverCDP(cdpUrl);
    const contexts = browser.contexts();
    let page: Page | undefined;
    for (const ctx of contexts) {
      for (const p of ctx.pages()) {
        if (/knowledgebase\.sangfor\.com/i.test(p.url())) {
          page = p;
          break;
        }
      }
      if (page) break;
    }
    const context = page?.context() ?? contexts[0] ?? await browser.newContext();
    page ??= context.pages()[0] ?? await context.newPage();
    return {
      browser,
      context,
      page,
      close: async () => { /* keep Glass/CDP browser open */ }
    };
  }

  const browser = await chromium.launch({
    headless: !headed,
    args: headed ? ['--start-maximized'] : []
  });
  const context = await createKbContextWithStorage(browser, headed);
  const page = await context.newPage();
  return {
    browser,
    context,
    page,
    close: async () => {
      await context.close();
      await browser.close();
    }
  };
}
