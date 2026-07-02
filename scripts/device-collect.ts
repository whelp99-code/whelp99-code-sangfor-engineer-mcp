/**
 * Login (captcha handshake if needed) + traverse ALL left-nav pages + capture every
 * authenticated /api XHR response → comprehensive ConfigState pool. Writes incrementally
 * so a mid-traversal session timeout still keeps captured data.
 *
 *   PRODUCT=EPP pnpm exec tsx scripts/device-collect.ts
 *   PRODUCT=IAG pnpm exec tsx scripts/device-collect.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium, type Page } from 'playwright';
import { ensureChromeRunning } from '../packages/sangfor-chrome/src/index.js';
import { isSafeNavLabel } from '../packages/sangfor-collector/src/safe-nav.js';

const PRODUCT = (process.env.PRODUCT ?? 'EPP').toUpperCase();
const CFG: Record<string, any> = {
  EPP: { url: 'https://10.80.1.106', user: 'admin', pass: 'Itac123!@#', port: 9340, captchaSel: 'img[src*="randcode"]', userSel: '#user, input[name="user"]', passSel: '#password, input[type="password"]', apiRe: /\/api\//, menuSel: 'li.ix-menu-item' },
  IAG: { url: 'https://10.80.1.108', user: 'admin', pass: 'Itac123#@!', port: 9342, captchaSel: 'img[src*="captcha"], img[src*="randcode"]', userSel: '#user, input[name="user"], input[name="username"]', passSel: '#password, input[type="password"]', apiRe: /\/(api|php|rest|cgi)/, menuSel: 'li.ix-menu-item' },
};
const c = CFG[PRODUCT];
if (!c) { console.error('unknown product', PRODUCT); process.exit(1); }
const DIR = '/tmp/dev-captcha';
const OUT = `${DIR}/${PRODUCT}_pool.json`;
const CAPTCHA_PNG = `${DIR}/${PRODUCT}.png`;
const CODE_FILE = `${DIR}/${PRODUCT}.code`;
mkdirSync(DIR, { recursive: true });
const sl = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const session = await ensureChromeRunning({ cdpPort: c.port, headless: true });
  const cdpHttp = session.cdpEndpoint ?? `http://127.0.0.1:${c.port}`;
  for (let i = 0; i < 20; i++) { try { if ((await fetch(`${cdpHttp}/json/version`)).ok) break; } catch {} await sl(500); }
  const browser = await chromium.connectOverCDP(cdpHttp);
  const ctx = browser.contexts()[0] ?? await browser.newContext({ ignoreHTTPSErrors: true });
  const page: Page = ctx.pages()[0] ?? await ctx.newPage();

  const pool: Record<string, any> = {};
  page.on('response', async (resp) => {
    const u = resp.url();
    if (!u.includes(c.url.replace('https://', '')) || !c.apiRe.test(u)) return;
    const key = resp.request().method() + ' ' + u.split('?')[0].replace(c.url, '');
    try { if (/json/.test(resp.headers()['content-type'] ?? '')) { const j = await resp.json(); pool[key] = j?.data ?? j; writeFileSync(OUT, JSON.stringify(pool, null, 2)); } } catch {}
  });

  // ── login ──
  console.error(`[${PRODUCT}] goto ${c.url}`);
  await page.goto(c.url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await sl(5000);

  // capture captcha FIRST (before filling fields, to avoid triggering a reload)
  let captchaCode = '';
  const captcha = page.locator(c.captchaSel).first();
  if (await captcha.isVisible({ timeout: 3000 }).catch(() => false)) {
    const box = await captcha.boundingBox();
    if (box) {
      await page.screenshot({ path: CAPTCHA_PNG, clip: { x: Math.max(0, box.x - 4), y: Math.max(0, box.y - 4), width: box.width + 8, height: box.height + 8 } });
      console.error(`[${PRODUCT}] CAPTCHA_READY: ${CAPTCHA_PNG} — waiting for ${CODE_FILE}`);
      const deadline = Date.now() + 180000; let code = '';
      while (Date.now() < deadline) { if (existsSync(CODE_FILE)) { code = readFileSync(CODE_FILE, 'utf8').trim(); if (code) break; } await sl(2000); }
      captchaCode = code;
    }
  }

  // fill user, password, captcha together AFTER capturing captcha
  await page.locator(c.userSel).first().fill(c.user).catch(() => {});
  await page.locator(c.passSel).first().fill(c.pass).catch(() => {});
  if (captchaCode) {
    for (const s of ['input[name="captcha"]', 'input[name="verify_code"]', 'input[name="code"]', 'input[placeholder*="code" i]']) {
      const el = page.locator(s).first(); if (await el.count().catch(() => 0)) { await el.fill(captchaCode).catch(() => {}); break; }
    }
  }
  // check any visible unchecked agreement checkbox (required by some consoles, e.g. IAG)
  try {
    const cb = page.locator('input[type="checkbox"]').first();
    if (await cb.count().catch(() => 0) && !(await cb.isChecked().catch(() => true))) await cb.check({ timeout: 2000 }).catch(() => {});
  } catch { /* ignore */ }
  for (const s of ['button:has-text("Log In")', 'button:has-text("Login")', 'input#button', 'button[type="submit"]', 'input[type="submit"]']) {
    const el = page.locator(s).first(); if (await el.count().catch(() => 0)) { await el.click({ timeout: 5000 }).catch(() => {}); break; }
  }
  await sl(6000);
  const loggedIn = !/login/i.test(page.url());
  console.error(`[${PRODUCT}] loggedIn=${loggedIn} url=${page.url()}`);
  if (!loggedIn) { console.error(`[${PRODUCT}] LOGIN_FAIL`); await browser.close(); return; }
  await page.screenshot({ path: `${DIR}/${PRODUCT}_home.png` }).catch(() => {});

  // ── traverse: collect menu labels (per-product menuSel), click only safe ones ──
  const MENU_SEL: string = c.menuSel ?? 'li.ix-menu-item';
  const dumpLabels = async (): Promise<string[]> => page.evaluate((sel) => {
    const els = [...document.querySelectorAll(sel)] as HTMLElement[];
    const visible = els.filter((e) => e.offsetParent !== null);
    return [...new Set(visible.map((e) => (e.innerText || e.textContent || '').trim().split('\n')[0])
      .filter((t) => t && t.length > 1 && t.length < 28 && !/^\d+$/.test(t)))];
  }, MENU_SEL);
  await page.goto(page.url(), { waitUntil: 'domcontentloaded' }).catch(() => {});
  await sl(6000);
  const seen = new Set<string>();
  for (let pass = 0; pass < 3; pass++) {
    const labels = await dumpLabels();
    for (const label of labels) {
      if (seen.has(label)) continue; seen.add(label);
      if (!isSafeNavLabel(label)) { console.error(`[${PRODUCT}] SKIP unsafe label: "${label}"`); continue; }
      try {
        await page.evaluate(({ text, sel }) => {
          const els = [...document.querySelectorAll(sel)] as HTMLElement[];
          const el = els.find((e) => (e.innerText || e.textContent || '').trim().split('\n')[0] === text);
          if (el) (el as HTMLElement).click();
        }, { text: label, sel: MENU_SEL });
        await sl(1500);
      } catch {}
    }
    console.error(`[${PRODUCT}] pass ${pass}: ${seen.size} labels visited, pool=${Object.keys(pool).length} apis`);
  }

  writeFileSync(OUT, JSON.stringify(pool, null, 2));
  console.error(`[${PRODUCT}] DONE — captured ${Object.keys(pool).length} api endpoints → ${OUT}`);
  console.error(Object.keys(pool).slice(0, 60).join('\n'));
  await browser.close();
}
main().catch((e) => { console.error('fatal', e); process.exit(1); });
