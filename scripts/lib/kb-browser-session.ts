/**
 * Shared Playwright session for authenticated knowledgebase.sangfor.com browsing.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { loadOneSessionFromEnv, resolveAuthTokens } from '../../packages/sangfor-collector/src/index.js';
import type { OneSessionConfig } from '../../packages/sangfor-collector/src/one-session.js';

const KB_HOME = 'https://knowledgebase.sangfor.com/home';
const KB_BASE = 'https://knowledgebase.sangfor.com';
const ONE_BASE = 'https://one.sangfor.com';

const SAFARI_WEBKIT_DEFAULT = join(
  process.env.HOME ?? '',
  'Library/Containers/com.apple.Safari/Data/Library/WebKit/WebsiteData/Default'
);

export interface KbBrowserTokens {
  libraryToken: string;
  tokenByCode: string;
  oneAccessToken?: string;
}

function decodeWebKitLocalStorageValue(hex: string): string {
  const buf = Buffer.from(hex, 'hex');
  if (buf.length >= 4 && buf[1] === 0 && buf[3] === 0) {
    return buf.toString('utf16le').replace(/\0/g, '');
  }
  return buf.toString('utf8');
}

function readSafariKbLocalStorage(): Record<string, string> | undefined {
  const base = process.env.SAFARI_WEBKIT_DEFAULT?.trim() || SAFARI_WEBKIT_DEFAULT;
  if (!existsSync(base)) return undefined;

  let entries: string[];
  try {
    entries = readdirSync(base);
  } catch {
    // macOS sandbox or permission issue — Safari data not accessible
    return undefined;
  }

  for (const entry of entries) {
    const originPath = join(base, entry, entry, 'origin');
    const dbPath = join(base, entry, entry, 'LocalStorage', 'localstorage.sqlite3');
    if (!existsSync(originPath) || !existsSync(dbPath)) continue;
    const origin = readFileSync(originPath, 'utf8');
    if (!origin.includes('knowledgebase.sangfor.com')) continue;
    const out = execSync(
      `sqlite3 -json ${JSON.stringify(dbPath)} "SELECT key, hex(value) AS value_hex FROM ItemTable;"`,
      { encoding: 'utf8', maxBuffer: 50_000_000 }
    );
    const parsed = JSON.parse(out.trim() || '[]') as Array<{ key: string; value_hex: string }>;
    const rows: Record<string, string> = {};
    for (const row of parsed) rows[row.key] = decodeWebKitLocalStorageValue(row.value_hex);
    return rows;
  }
  return undefined;
}

export async function resolveKbBrowserTokens(config: OneSessionConfig = loadOneSessionFromEnv()): Promise<KbBrowserTokens> {
  const resolved = await resolveAuthTokens(config);
  const safari = readSafariKbLocalStorage();

  const libraryToken =
    resolved.kbToken?.trim()
    || config.kbToken?.trim()
    || safari?.library_token?.trim()
    || '';

  const tokenByCode =
    process.env.SANGFOR_KB_TOKEN_BY_CODE?.trim()
    || safari?.token_by_code?.trim()
    || libraryToken;

  const oneAccessToken =
    resolved.oneAccessToken?.trim()
    || config.accessToken?.trim()
    || safari?.access_token_mh?.trim()
    || safari?.idt_token?.trim();

  return { libraryToken, tokenByCode, oneAccessToken };
}

export async function injectKbSession(page: Page, tokens: KbBrowserTokens): Promise<void> {
  await page.goto(KB_BASE, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.evaluate((t) => {
    if (t.library) localStorage.setItem('library_token', t.library);
    if (t.byCode) localStorage.setItem('token_by_code', t.byCode);
    if (t.one) {
      localStorage.setItem('access_token_mh', t.one);
      localStorage.setItem('access_token', t.one);
    }
    localStorage.setItem('library_login_type', 'partner');
  }, {
    library: tokens.libraryToken,
    byCode: tokens.tokenByCode,
    one: tokens.oneAccessToken ?? ''
  });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
}

/** Open KB via ONE partner context so Vue app recognizes session. */
export async function openKbViaOne(page: Page, tokens: KbBrowserTokens): Promise<void> {
  if (!tokens.oneAccessToken) {
    await injectKbSession(page, tokens);
    return;
  }
  try {
    await page.goto(ONE_BASE, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } catch {
    // ONE portal unreachable — fall back to direct KB injection
    await injectKbSession(page, tokens);
    return;
  }
  await page.evaluate((t) => {
    if (t.one) {
      localStorage.setItem('access_token_mh', t.one);
      localStorage.setItem('access_token', t.one);
    }
    if (t.library) localStorage.setItem('library_token', t.library);
    if (t.byCode) localStorage.setItem('token_by_code', t.byCode);
    localStorage.setItem('library_login_type', 'partner');
  }, {
    one: tokens.oneAccessToken ?? '',
    library: tokens.libraryToken,
    byCode: tokens.tokenByCode
  });

  const kbEntry = page.locator('a[href*="knowledgebase"], a[href*="knowledge"]').first();
  if (await kbEntry.count()) {
    await kbEntry.click({ timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(3000);
  }
  if (!page.url().includes('knowledgebase')) {
    await page.goto(KB_HOME, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await injectKbSession(page, tokens);
  }
}

export async function waitForKbReady(page: Page, timeoutMs = 45_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => {
      const text = (document.body?.innerText || '').slice(0, 4000);
      const loginOnly = /^\s*Login\s*$/im.test(text.trim()) || (text.includes('Login') && text.length < 800);
      const hasTiles = document.querySelectorAll('.home-page button, .home-page [class*="product"], .home-page .el-button').length > 5;
      const hasNav = document.querySelectorAll('.el-menu-item').length > 3;
      const treeLen = localStorage.getItem('library_tree')?.length ?? 0;
      const links = document.querySelectorAll('a[href*="detailPage"]').length;
      return { loginOnly, hasTiles, hasNav, treeLen, links, url: location.href };
    });
    if (!state.loginOnly && (state.hasTiles || state.hasNav || state.treeLen > 500 || state.links > 0)) {
      return true;
    }
    await page.waitForTimeout(1500);
  }
  return false;
}

export function readSafariLibraryTree(): string | undefined {
  const rows = readSafariKbLocalStorage();
  const tree = rows?.library_tree;
  return tree && tree.length > 100 ? tree : undefined;
}

export interface KbBrowserHandle {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  close: () => Promise<void>;
}

const CHROME_PROFILE = process.env.CHROME_USER_DATA ?? (
  process.platform === 'darwin'
    ? `${process.env.HOME}/Library/Application Support/Google/Chrome`
    : `${process.env.HOME}/.config/google-chrome`
);

const DEFAULT_CDP_URL = 'http://127.0.0.1:9222';

export async function launchKbBrowser(tokens: KbBrowserTokens): Promise<KbBrowserHandle> {
  const cdpUrl = (
    process.env.SANGFOR_CDP_URL?.trim()
    || (process.env.SANGFOR_GLASS_CDP_REQUIRED === '1' ? DEFAULT_CDP_URL : '')
  );
  const headed = process.env.SANGFOR_KB_HEADED === '1';
  const useChromeProfile = process.env.SANGFOR_USE_CHROME_PROFILE === '1';

  if (useChromeProfile && existsSync(CHROME_PROFILE)) {
    const context = await chromium.launchPersistentContext(CHROME_PROFILE, {
      channel: 'chrome',
      headless: false,
      args: ['--profile-directory=Default'],
      ignoreHTTPSErrors: true
    });
    const page = context.pages()[0] ?? await context.newPage();
    const browser = context.browser()!;
    return {
      browser,
      context,
      page,
      close: async () => { await context.close(); }
    };
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
  const context = await browser.newContext(
    headed ? { viewport: null, ignoreHTTPSErrors: true } : { ignoreHTTPSErrors: true }
  );
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

export async function prepareKbPage(tokens: KbBrowserTokens, page: Page): Promise<boolean> {
  if (process.env.SANGFOR_CDP_URL && /knowledgebase\.sangfor\.com/i.test(page.url())) {
    return waitForKbReady(page);
  }
  // Navigate directly to KB and inject tokens — skip ONE portal in headless mode
  try {
    await page.goto(KB_HOME, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } catch {
    // If KB_HOME fails, try base URL first
    try {
      await page.goto(KB_BASE, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch {
      return false;
    }
  }
  await injectKbSession(page, tokens);
  return waitForKbReady(page);
}
