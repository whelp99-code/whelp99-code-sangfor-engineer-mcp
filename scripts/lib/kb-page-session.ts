/**
 * Driving an open page into an authenticated knowledgebase.sangfor.com session:
 * navigate, plant the tokens the Vue app reads from localStorage, and wait until
 * the app has rendered something other than the login screen.
 */
import type { Page } from 'playwright';
import { saveKbStorageState } from './kb-browser-launcher.js';
import type { KbBrowserTokens } from './kb-browser-contracts.js';

const KB_HOME = 'https://knowledgebase.sangfor.com/home';
const KB_BASE = 'https://knowledgebase.sangfor.com';
const ONE_BASE = 'https://one.sangfor.com';

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
  const ready = await waitForKbReady(page);
  if (ready) {
    await saveKbStorageState(page.context()).catch(() => {});
  }
  return ready;
}
