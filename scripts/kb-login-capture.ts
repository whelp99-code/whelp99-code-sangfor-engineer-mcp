/**
 * Headed login to Sangfor Library/Support via "Partner Login (Non EMEA)".
 * Prefills credentials, leaves the window OPEN so a human can solve CAPTCHA/2FA,
 * polls localStorage on knowledgebase + support origins for tokens, writes .env.
 *
 *   pnpm exec tsx scripts/kb-login-capture.ts
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page, type BrowserContext } from 'playwright';
import { loadEnvFile } from '../packages/sangfor-collector/src/load-env.js';

loadEnvFile('.env');

const KB_HOME = 'https://knowledgebase.sangfor.com/home';
const EMAIL = process.env.SANGFOR_KB_LOGIN_EMAIL ?? '';
const PASSWORD = process.env.SANGFOR_KB_LOGIN_PASSWORD ?? '';
const LOGIN_CHOICE = process.env.SANGFOR_LOGIN_CHOICE ?? 'Partner Login (Non EMEA)';
const SHOT = '/tmp/kb-login';
const POLL_MS = Number(process.env.KB_LOGIN_POLL_MS ?? 600_000);
const USER_DATA = '/tmp/sangfor-kb-profile';
const STORAGE_STATE = 'data/sources/kb-storage-state.json';
const TOKEN_KEYS = ['library_token', 'token_by_code', 'access_token_mh', 'access_token', 'idt_token'];

mkdirSync(SHOT, { recursive: true });
let n = 0;
const shot = async (page: Page, label: string) => {
  await page.screenshot({ path: join(SHOT, `${String(++n).padStart(2, '0')}_${label}.png`) }).catch(() => {});
};

async function readTokens(page: Page): Promise<Record<string, string>> {
  try {
    return await page.evaluate((keys) => {
      const out: Record<string, string> = {};
      for (const k of keys) { const v = localStorage.getItem(k); if (v) out[k] = v; }
      return out;
    }, TOKEN_KEYS);
  } catch { return {}; }
}

async function scanAllTokens(context: BrowserContext): Promise<Record<string, string>> {
  let found: Record<string, string> = {};
  for (const p of context.pages()) {
    const t = await readTokens(p);
    found = { ...found, ...t };
  }
  return found;
}

function upsertEnv(updates: Record<string, string>) {
  let content = existsSync('.env') ? readFileSync('.env', 'utf8') : '';
  for (const [k, v] of Object.entries(updates)) {
    if (!v) continue;
    const line = `${k}="${v}"`;
    const re = new RegExp(`^${k}=.*$`, 'm');
    content = re.test(content) ? content.replace(re, line) : `${content}\n${line}`;
  }
  writeFileSync('.env', content);
}

async function prefill(page: Page) {
  // Username/Email: the first visible non-password text input
  const userInput = page.locator('input:not([type="password"]):not([type="checkbox"]):not([type="hidden"]):visible').first();
  if (await userInput.count().catch(() => 0)) { await userInput.fill(EMAIL).catch(() => {}); }
  // Password
  const passInput = page.locator('input[type="password"]:visible').first();
  if (await passInput.count().catch(() => 0)) { await passInput.fill(PASSWORD).catch(() => {}); }
  // tick the "I have read and agree to the Privacy Policy" checkbox (enables Log in)
  const cb = page.locator('input[type="checkbox"]').first();
  if (await cb.count().catch(() => 0)) {
    await cb.check({ timeout: 4000 }).catch(async () => {
      // some UIs render a custom checkbox — click the agree text
      await page.locator('text=/agree to the/i').first().click({ timeout: 4000 }).catch(() => {});
    });
  }
  await page.waitForTimeout(800);
  // click Log in
  for (const s of ['button:has-text("Log in")', 'button:has-text("Login")', 'button[type="submit"]', 'text=/^\\s*Log in\\s*$/i']) {
    const btn = page.locator(s).first();
    if (await btn.count().catch(() => 0)) {
      await btn.click({ timeout: 5000 }).catch(() => {});
      break;
    }
  }
}

async function main() {
  console.error(`[login] launching headed Chrome (persistent) → ${KB_HOME}`);
  const context = await chromium.launchPersistentContext(USER_DATA, {
    headless: false, channel: 'chrome', viewport: null,
    args: ['--start-maximized'], ignoreHTTPSErrors: true,
    ignoreDefaultArgs: ['--enable-automation'],
  }).catch(() => chromium.launchPersistentContext(USER_DATA, { headless: false, ignoreHTTPSErrors: true }));

  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(KB_HOME, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(3500);

  // already authenticated from a prior run?
  let tokens = await scanAllTokens(context);
  if (!(tokens.library_token || tokens.token_by_code)) {
    await shot(page, 'home');
    // open Login dropdown
    const loginToggle = page.locator('text=/^\\s*Login\\s*$/i').first();
    if (await loginToggle.count().catch(() => 0)) { await loginToggle.click({ timeout: 8000 }).catch(() => {}); }
    await page.waitForTimeout(1200);
    await shot(page, 'login_menu');

    // click the chosen partner login (may open a new tab → ONE OAuth)
    const before = context.pages().length;
    const choice = page.locator(`text=${JSON.stringify(LOGIN_CHOICE)}`).first();
    if (await choice.count().catch(() => 0)) {
      await choice.click({ timeout: 8000 }).catch(() => {});
    } else {
      console.error(`[login] could not find menu item "${LOGIN_CHOICE}" — solve in window`);
    }
    await page.waitForTimeout(5000);

    // a new tab may have opened for OAuth
    const pages = context.pages();
    const loginPage = pages.length > before ? pages[pages.length - 1] : page;
    await loginPage.bringToFront().catch(() => {});
    await loginPage.waitForLoadState('domcontentloaded').catch(() => {});
    await loginPage.waitForTimeout(2500);
    await shot(loginPage, 'partner_oauth');

    await prefill(loginPage).catch((e) => console.error('[login] prefill', String(e)));
    await loginPage.waitForTimeout(4000);
    await shot(loginPage, 'after_submit');
    console.error('[login] submitted. If a CAPTCHA/2FA appears, complete it IN THE WINDOW.');
  }

  console.error(`[login] polling up to ${Math.round(POLL_MS / 1000)}s for KB token across all tabs…`);
  const deadline = Date.now() + POLL_MS;
  while (Date.now() < deadline) {
    tokens = await scanAllTokens(context);
    if (tokens.library_token || tokens.token_by_code) break;
    await page.waitForTimeout(5000);
  }

  const last = context.pages()[context.pages().length - 1] ?? page;
  await shot(last, 'final');

  if (tokens.library_token || tokens.token_by_code) {
    upsertEnv({
      SANGFOR_KB_TOKEN: tokens.library_token ?? '',
      SANGFOR_LIBRARY_TOKEN: tokens.library_token ?? '',
      SANGFOR_KB_TOKEN_BY_CODE: tokens.token_by_code ?? tokens.library_token ?? '',
      SANGFOR_ONE_ACCESS_TOKEN: tokens.access_token_mh ?? tokens.access_token ?? tokens.idt_token ?? '',
    });
    mkdirSync('data/sources', { recursive: true });
    writeFileSync(STORAGE_STATE, JSON.stringify(await context.storageState(), null, 2));
    console.error(`[login] SUCCESS — library_token len=${(tokens.library_token ?? '').length}, token_by_code len=${(tokens.token_by_code ?? '').length}. .env + ${STORAGE_STATE} written.`);
    console.error('[login] keeping window open 20s then closing…');
    await page.waitForTimeout(20_000);
  } else {
    console.error('[login] no token captured before timeout. See /tmp/kb-login/*.png');
  }
  await context.close();
}

main().catch((e) => { console.error('[login] fatal', e); process.exit(1); });
