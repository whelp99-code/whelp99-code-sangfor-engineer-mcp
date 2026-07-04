/**
 * Captcha-aware read-only device login, using the "no-refresh live captcha → vision
 * read → immediate input" method. The vision reader is the operator (Claude): the
 * script screenshots the live captcha and waits for a code file, then types it.
 *
 *   PRODUCT=EPP pnpm exec tsx scripts/device-login.ts
 *   (script writes /tmp/dev-captcha/<product>.png, then polls <product>.code)
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { chromium, type Page } from 'playwright';
import { ensureChromeRunning, takeScreenshot, getPageSnapshot } from '../packages/sangfor-chrome/src/index.js';

const PRODUCT = (process.env.PRODUCT ?? 'EPP').toUpperCase();
const CFG: Record<string, { url: string; user: string; pass: string; port: number; captchaSel: string; userSel: string; passSel: string }> = {
  EPP: { url: 'https://10.80.1.106', user: 'admin', pass: process.env.EPP_PASS ?? 'Itac123!@#', port: 9340, captchaSel: 'img[src*="randcode"]', userSel: '#user, input[name="user"], input[name="username"]', passSel: '#password, input[type="password"]' },
  CC:  { url: 'https://10.80.1.107', user: 'admin', pass: process.env.CC_PASS ?? 'Itac123!@#', port: 9341, captchaSel: 'img.uedc-ppkg-login_captcha, img[src*="captcha"]', userSel: 'input[name="name"], input[name="username"], input[name="user"], #username', passSel: 'input[type="password"]' },
};
const c = CFG[PRODUCT];
if (!c) { console.error('unknown product', PRODUCT); process.exit(1); }

const DIR = '/tmp/dev-captcha';
mkdirSync(DIR, { recursive: true });
const CAPTCHA_PNG = `${DIR}/${PRODUCT}.png`;
const CODE_FILE = `${DIR}/${PRODUCT}.code`;
const sl = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForCode(timeoutMs = 180_000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(CODE_FILE)) {
      const code = readFileSync(CODE_FILE, 'utf8').trim();
      if (code) return code;
    }
    await sl(2000);
  }
  return null;
}

async function main() {
  const session = await ensureChromeRunning({ cdpPort: c.port, headless: true });
  const cdpHttp = session.cdpEndpoint ?? `http://127.0.0.1:${c.port}`;
  // wait until Chrome's CDP http endpoint is ready
  for (let i = 0; i < 20; i++) {
    try { const r = await fetch(`${cdpHttp}/json/version`); if (r.ok) break; } catch {}
    await sl(500);
  }
  const browser = await chromium.connectOverCDP(cdpHttp);
  const ctx = browser.contexts()[0] ?? await browser.newContext({ ignoreHTTPSErrors: true });
  const page = ctx.pages()[0] ?? await ctx.newPage();

  console.error(`[${PRODUCT}] goto ${c.url}`);
  await page.goto(c.url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await sl(15000);
  await takeScreenshot(page, `${DIR}/${PRODUCT}_01_login.png`);

  // click EULA agreement if visible
  for (const s of ['.uedc-ppkg-login_product-footer-right-wrap', '.uedc-ppkg-register_policy-wrap', 'input[type="checkbox"]']) {
    const el = page.locator(s).first();
    if (await el.count().catch(() => 0)) {
      if (s === '.uedc-ppkg-login_product-footer-right-wrap') {
        console.error(`[${PRODUCT}] clicking agreement selector at offset (checkbox): ${s}`);
        await el.click({ position: { x: 10, y: 10 }, timeout: 2000 }).catch(() => {});
      } else {
        console.error(`[${PRODUCT}] clicking agreement selector: ${s}`);
        await el.click({ timeout: 2000 }).catch(() => {});
      }
      await sl(500);
    }
  }

  // fill credentials WITHOUT reloading the page (reload regenerates captcha)
  await page.locator(c.userSel).first().fill(c.user).catch(() => {});
  await page.locator(c.passSel).first().fill(c.pass).catch(() => {});
  await sl(1000);

  const captcha = page.locator(c.captchaSel).first();
  const hasCaptcha = await captcha.isVisible({ timeout: 5000 }).catch(() => false);
  if (hasCaptcha) {
    let box = await captcha.boundingBox();
    for (let attempt = 0; attempt < 10 && (!box || box.width === 0 || box.height === 0); attempt++) {
      await sl(1500);
      box = await captcha.boundingBox();
    }
    if (box && box.width > 0 && box.height > 0) {
      await captcha.screenshot({ path: CAPTCHA_PNG }).catch(async () => {
        await page.screenshot({ path: CAPTCHA_PNG });
      });
      console.error(`[${PRODUCT}] CAPTCHA_READY: ${CAPTCHA_PNG} — waiting for ${CODE_FILE}`);
      const code = await waitForCode();
      if (!code) { console.error(`[${PRODUCT}] no captcha code provided in time`); await browser.close(); return; }
      console.error(`[${PRODUCT}] got code "${code}", typing (no reload)`);
      // captcha input field: try common selectors
      for (const s of ['input[name="captcha"]', 'input[name="verify_code"]', 'input[name="code"]', 'input[placeholder*="code" i]', 'input[placeholder*="验证" i]']) {
        const el = page.locator(s).first();
        if (await el.count().catch(() => 0)) { await el.fill(code).catch(() => {}); break; }
      }
    }
  } else {
    console.error(`[${PRODUCT}] no captcha detected`);
  }

  await sl(300);
  // submit
  for (const s of ['button:has-text("Log In")', 'button:has-text("Login")', 'input#button', 'button[type="submit"]', 'input[type="submit"]']) {
    const el = page.locator(s).first();
    if (await el.count().catch(() => 0)) { await el.click({ timeout: 5000 }).catch(() => {}); break; }
  }
  await sl(6000);
  await takeScreenshot(page, `${DIR}/${PRODUCT}_02_after_login.png`);
  const url = page.url();
  const snap = (await getPageSnapshot(page).catch(() => '')).slice(0, 200).replace(/\s+/g, ' ');
  const loggedIn = !/login/i.test(url);
  console.error(`[${PRODUCT}] after login: url=${url} loggedIn=${loggedIn}`);
  console.error(`[${PRODUCT}] page text: ${snap}`);
  console.error(`[${PRODUCT}] RESULT: ${loggedIn ? 'LOGIN_OK' : 'LOGIN_FAIL'} (session kept on CDP port ${c.port})`);
  await browser.close(); // detaches CDP but Chrome + session stays for follow-up extraction
}
main().catch((e) => { console.error('fatal', e); process.exit(1); });
