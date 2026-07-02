/**
 * EPP config capture via Chrome CDP (read-only). Correct CAPTCHA order (screenshot the
 * captcha FIRST, then fill user/pass/captcha together), then route-based navigation
 * (click each router-link) to fire and capture the app's authenticated /api XHR pool.
 * Handshake: writes captcha PNG, waits for /tmp/dev-captcha/EPP.code (I read + provide).
 *
 *   pnpm exec tsx scripts/epp-capture-cdp.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium, type Page } from 'playwright';
import { ensureChromeRunning } from '../packages/sangfor-chrome/src/index.js';

const DIR = '/tmp/dev-captcha';
const OUT = `${DIR}/EPP_pool.json`;
const CAP = `${DIR}/EPP.png`;
const CODE = `${DIR}/EPP.code`;
mkdirSync(DIR, { recursive: true });
const sl = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const session = await ensureChromeRunning({ cdpPort: 9340, headless: true });
  const cdp = session.cdpEndpoint ?? 'http://127.0.0.1:9340';
  for (let i = 0; i < 20; i++) { try { if ((await fetch(`${cdp}/json/version`)).ok) break; } catch {} await sl(500); }
  const browser = await chromium.connectOverCDP(cdp);
  const ctx = browser.contexts()[0] ?? await browser.newContext({ ignoreHTTPSErrors: true });
  const page: Page = ctx.pages()[0] ?? await ctx.newPage();

  const pool: Record<string, any> = {};
  page.on('response', async (resp) => {
    const u = resp.url();
    if (!/\/api\/edrgoweb\/v1\//.test(u)) return;
    try { if (/json/.test(resp.headers()['content-type'] ?? '')) { const j = await resp.json(); pool[resp.request().method() + ' ' + u.split('?')[0].replace('https://10.80.1.106', '')] = j?.data ?? j; writeFileSync(OUT, JSON.stringify(pool, null, 2)); } } catch {}
  });

  await page.goto('https://10.80.1.106', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await sl(5000);

  // ── login, CORRECT ORDER: read captcha first ──
  const cap = page.locator('img[src*="randcode"]').first();
  if (await cap.isVisible({ timeout: 5000 }).catch(() => false)) {
    // wait for the captcha image to actually load
    for (let i = 0; i < 20; i++) { const ok = await page.evaluate(() => { const im = document.querySelector('img[src*="randcode"]') as HTMLImageElement | null; return !!(im && im.complete && im.naturalWidth > 0); }); if (ok) break; await sl(1000); }
    const box = await cap.boundingBox();
    if (box) await page.screenshot({ path: CAP, clip: { x: Math.max(0, box.x - 4), y: Math.max(0, box.y - 4), width: box.width + 8, height: box.height + 8 } });
    console.error(`CAPTCHA_READY: ${CAP} — waiting for ${CODE}`);
    let code = ''; const dl = Date.now() + 180000;
    while (Date.now() < dl) { if (existsSync(CODE)) { code = readFileSync(CODE, 'utf8').trim(); if (code) break; } await sl(2000); }
    await page.locator('#user').fill('admin').catch(() => {});
    await page.locator('#password').fill('Itac123!@#').catch(() => {});
    await page.locator('#code').fill(code).catch(() => {});
    await page.locator('#button').click({ timeout: 5000 }).catch(() => {});
  }
  await sl(7000);
  const loggedIn = !/login/i.test(page.url());
  console.error(`loggedIn=${loggedIn} url=${page.url()}`);
  if (!loggedIn) { console.error('LOGIN_FAIL'); await browser.close(); process.exit(1); }
  await sl(5000);

  // ── route-based navigation: click each router-link (no networkidle) ──
  const routes: string[] = await page.evaluate(() => {
    const set = new Set<string>();
    document.querySelectorAll('a[href^="#/"]').forEach((a) => set.add((a as HTMLAnchorElement).getAttribute('href') || ''));
    return [...set].filter(Boolean);
  });
  console.error(`routes(${routes.length}): ${JSON.stringify(routes)}`);
  for (const r of routes) {
    try { await page.locator(`a[href="${r}"]`).first().click({ timeout: 3000 }); await sl(2800); } catch {}
  }

  writeFileSync(OUT, JSON.stringify(pool, null, 2));
  console.error(`DONE endpoints=${Object.keys(pool).length} → ${OUT}`);
  console.error(Object.keys(pool).sort().join('\n'));
  await browser.close();
}
main().catch((e) => { console.error('fatal', e); process.exit(1); });
