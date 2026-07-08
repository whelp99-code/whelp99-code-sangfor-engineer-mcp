/** Read-only: log into EPP (captcha-first), safe-navigate to General Policies, and DUMP
 *  the policy structure + toggle states (no button clicks) so quarantine/EDR settings can
 *  be read. Only clicks safe nav (isSafeNavLabel-gated). Writes screenshots + a JSON dump. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium, type Page } from 'playwright';
import { ensureChromeRunning } from '../packages/sangfor-chrome/src/index.js';
import { isSafeNavLabel } from '../packages/sangfor-collector/src/safe-nav.js';

const reqPass = (k: string): string => { const v = process.env[k]; if (!v) { console.error(`missing env: ${k}`); process.exit(1); } return v; };

const DIR = '/tmp/dev-captcha';
mkdirSync(DIR, { recursive: true });
const CAP = `${DIR}/EPP.png`; const CODE = `${DIR}/EPP.code`;
const sl = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const session = await ensureChromeRunning({ cdpPort: 9340, headless: true });
  const cdp = session.cdpEndpoint ?? 'http://127.0.0.1:9340';
  for (let i = 0; i < 20; i++) { try { if ((await fetch(`${cdp}/json/version`)).ok) break; } catch {} await sl(500); }
  const browser = await chromium.connectOverCDP(cdp);
  const ctx = browser.contexts()[0] ?? await browser.newContext({ ignoreHTTPSErrors: true });
  const page: Page = ctx.pages()[0] ?? await ctx.newPage();

  await page.goto('https://10.80.1.106', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await sl(5000);
  // captcha-first login (only if not already logged in)
  if (/login/i.test(page.url())) {
    const cap = page.locator('img[src*="randcode"]').first();
    if (await cap.isVisible({ timeout: 5000 }).catch(() => false)) {
      for (let i = 0; i < 20; i++) { const ok = await page.evaluate(() => { const im = document.querySelector('img[src*="randcode"]') as HTMLImageElement | null; return !!(im && im.complete && im.naturalWidth > 0); }); if (ok) break; await sl(1000); }
      const box = await cap.boundingBox();
      if (box) await page.screenshot({ path: CAP, clip: { x: Math.max(0, box.x - 4), y: Math.max(0, box.y - 4), width: box.width + 8, height: box.height + 8 } });
      console.error(`CAPTCHA_READY: ${CAP} — waiting for ${CODE}`);
      let code = ''; const dl = Date.now() + 180000;
      while (Date.now() < dl) { if (existsSync(CODE)) { code = readFileSync(CODE, 'utf8').trim(); if (code) break; } await sl(2000); }
      await page.locator('#user').fill('admin').catch(() => {});
      await page.locator('#password').fill(reqPass('SANGFOR_EPP_PASSWORD')).catch(() => {});
      await page.locator('#code').fill(code).catch(() => {});
      const cb = page.locator('input[type="checkbox"]').first();
      if (await cb.count().catch(() => 0) && !(await cb.isChecked().catch(() => true))) await cb.check({ timeout: 2000 }).catch(() => {});
      await page.locator('#button').click({ timeout: 5000 }).catch(() => {});
      await sl(7000);
    }
  }
  console.error(`loggedIn=${!/login/i.test(page.url())} url=${page.url()}`);

  // safe-navigate to General Policies (nav item; passes isSafeNavLabel)
  const target = 'General Policies';
  if (!isSafeNavLabel(target)) { console.error('target not safe?!'); await browser.close(); return; }
  await page.evaluate((txt) => { const el = [...document.querySelectorAll('li.ix-menu-item')].find((e) => ((e as HTMLElement).innerText || '').trim().split('\n')[0] === txt) as HTMLElement | undefined; if (el) el.click(); }, target);
  await sl(6000);
  await page.screenshot({ path: `${DIR}/EPP_genpolicies.png`, fullPage: false }).catch(() => {});

  // dump the in-page sub-nav + policy labels + toggle/switch states (read-only, no clicks)
  const dump = await page.evaluate(() => {
    const subnav = [...document.querySelectorAll('li.ix-menu-item, [role="tab"], .el-tabs__item, [class*="tab-item"], [class*="policy"] [class*="title"]')]
      .filter((e) => (e as HTMLElement).offsetParent).map((e) => ((e as HTMLElement).innerText || '').trim().split('\n')[0]).filter((t) => t && t.length < 30);
    // switch/toggle components with their on/off state
    const toggles = [...document.querySelectorAll('[class*="switch"], [role="switch"], [class*="toggle"]')]
      .filter((e) => (e as HTMLElement).offsetParent)
      .map((e) => ({ cls: (e.className || '').toString().slice(0, 50), aria: e.getAttribute('aria-checked'), on: /is-checked|checked|is-active|active|-on\b/.test((e.className || '').toString()), near: ((e.parentElement?.innerText || '').trim().slice(0, 40)) }))
      .slice(0, 40);
    return { subnav: [...new Set(subnav)], toggles, bodyLen: document.body ? document.body.innerText.length : 0 };
  });
  console.error('SUBNAV: ' + JSON.stringify(dump.subnav));
  console.error('TOGGLES: ' + JSON.stringify(dump.toggles, null, 1));
  console.error('bodyLen=' + dump.bodyLen);
  await browser.close();
}
main().catch((e) => { console.error('fatal', e); process.exit(1); });
