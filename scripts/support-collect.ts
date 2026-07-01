/**
 * Collect Sangfor Support User Manual PDFs for priority products into the drive.
 * Flow (per user): log into one.sangfor.com with the partner account (lyndon.bear),
 * then navigate Resources → Sangfor Support (SSO auto-login to support.sangfor.com),
 * then download each product's manual PDF.
 *
 *   pnpm exec tsx scripts/support-collect.ts
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page, type BrowserContext } from 'playwright';
import { loadEnvFile } from '../packages/sangfor-collector/src/load-env.js';

loadEnvFile('.env');
const EMAIL = process.env.SANGFOR_KB_LOGIN_EMAIL ?? '';       // partner: lyndon.bear@nexias.co.kr
const PASSWORD = process.env.SANGFOR_KB_LOGIN_PASSWORD ?? '';
const USER_DATA = '/tmp/sangfor-kb-profile';
const DEST = process.env.SANGFOR_COLLECT_DEST ?? '/Volumes/My Passport/00. Attached/_SupportDocs';
const SHOT = '/tmp/kb-login';

const PRODUCTS = [
  { name: 'HCI_aSV',          product_id: 10, version_id: 1381, category_id: 2654158 },
  { name: 'EPP',              product_id: 23, version_id: 1041, category_id: 2633638 },
  { name: 'IAG_SWG',          product_id: 22, version_id: 1144, category_id: 94 },
  { name: 'NDR_CyberCommand', product_id: 24, version_id: 1219, category_id: 2630627 },
  { name: 'XDR',              product_id: 25, version_id: 1361, category_id: 2630333 },
  { name: 'NGFW',             product_id: 21, version_id: 1095, category_id: 2647630 },
];

mkdirSync(DEST, { recursive: true });
mkdirSync(SHOT, { recursive: true });
const nap = (p: Page, ms: number) => p.waitForTimeout(ms);

async function partnerLoginOne(page: Page) {
  await page.goto('https://one.sangfor.com', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await nap(page, 4000);
  if (!(await page.locator('text=/^\\s*Login\\s*$/i').first().count().catch(() => 0))) {
    console.error('[one] already logged in');
    return;
  }
  await page.locator('text=/^\\s*Login\\s*$/i').first().click({ timeout: 6000 }).catch(() => {});
  await nap(page, 1200);
  await page.locator('text=Partner Login (Non EMEA)').first().click({ timeout: 6000 }).catch(() => {});
  await nap(page, 5000);
  await page.screenshot({ path: join(SHOT, 'one_idtrust.png') }).catch(() => {});
  // IDTrust form: username, password, privacy checkbox, Log in
  const pass = page.locator('input[type="password"]:visible').first();
  if (await pass.count().catch(() => 0)) {
    const user = page.locator('input:not([type="password"]):not([type="checkbox"]):not([type="hidden"]):visible').first();
    if (await user.count().catch(() => 0)) { await user.fill(EMAIL).catch(() => {}); }
    await pass.fill(PASSWORD).catch(() => {});
    const cb = page.locator('input[type="checkbox"]').first();
    if (await cb.count().catch(() => 0)) await cb.check({ timeout: 3000 }).catch(() => {});
    await nap(page, 600);
    await page.getByRole('button', { name: /log ?in/i }).first().click({ timeout: 6000, force: true }).catch(() => {});
    await nap(page, 8000);
  }
  await page.goto('https://one.sangfor.com', { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
  await nap(page, 4000);
  await page.screenshot({ path: join(SHOT, 'one_after_login.png') }).catch(() => {});
}

async function gotoSupportViaResources(ctx: BrowserContext, page: Page): Promise<boolean> {
  // find a Resources menu, then a "Sangfor Support" link (may open a new tab)
  const before = ctx.pages().length;
  const res = page.locator('text=/^\\s*Resources?\\s*$/i').first();
  if (await res.count().catch(() => 0)) { await res.hover().catch(() => {}); await res.click({ timeout: 4000 }).catch(() => {}); await nap(page, 1500); }
  await page.screenshot({ path: join(SHOT, 'one_resources_menu.png') }).catch(() => {});
  const sup = page.locator('a:has-text("Sangfor Support"), text=/Sangfor Support/i').first();
  if (await sup.count().catch(() => 0)) {
    await sup.click({ timeout: 6000 }).catch(() => {});
  } else {
    console.error('[nav] "Sangfor Support" link not found on one.sangfor.com; opening support directly');
    await page.goto('https://support.sangfor.com/', { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
  }
  await nap(page, 7000);
  // a new tab may have opened
  const pages = ctx.pages();
  const supPage = pages.length > before ? pages[pages.length - 1] : page;
  await supPage.bringToFront().catch(() => {});
  await supPage.waitForLoadState('domcontentloaded').catch(() => {});
  await nap(supPage, 3000);
  await supPage.screenshot({ path: join(SHOT, 'support_landed.png') }).catch(() => {});
  const notLogged = await supPage.locator('text=/Please Log In First|^\\s*Log in\\s*$/i').first().count().catch(() => 0);
  return !notLogged;
}

async function downloadManual(ctx: BrowserContext, p: typeof PRODUCTS[number]): Promise<string> {
  const page = await ctx.newPage();
  const url = `https://support.sangfor.com/productDocument/read?product_id=${p.product_id}&version_id=${p.version_id}&category_id=${p.category_id}`;
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
    await nap(page, 5000);
    const dlPromise = page.waitForEvent('download', { timeout: 150000 });
    await page.locator('text=/^\\s*Download\\s*$/').first().click({ timeout: 8000 });
    await nap(page, 2500);
    const selectAll = page.locator('text=/Select All/i').first();
    if (await selectAll.count().catch(() => 0)) await selectAll.click({ timeout: 3000 }).catch(() => {});
    await nap(page, 600);
    await page.getByRole('button', { name: /^confirm$/i }).first().click({ timeout: 6000, force: true }).catch(async () => {
      await page.locator('button:has-text("Confirm"), .el-button--primary').last().click({ timeout: 4000 }).catch(() => {});
    });
    const dl = await dlPromise;
    const fn = dl.suggestedFilename() || `${p.name}.pdf`;
    const out = join(DEST, `${p.name}__UserManual__${fn}`);
    await dl.saveAs(out);
    await page.close();
    return `OK   ${p.name}: ${fn}`;
  } catch (e) {
    await page.screenshot({ path: join(SHOT, `fail_${p.name}.png`) }).catch(() => {});
    await page.close();
    return `FAIL ${p.name}: ${String(e).slice(0, 120)}`;
  }
}

async function main() {
  const ctx = await chromium.launchPersistentContext(USER_DATA, {
    headless: false, channel: 'chrome', viewport: null, args: ['--start-maximized'],
    ignoreHTTPSErrors: true, acceptDownloads: true, ignoreDefaultArgs: ['--enable-automation'],
  });
  const page = ctx.pages()[0] ?? await ctx.newPage();
  await partnerLoginOne(page);
  const ok = await gotoSupportViaResources(ctx, page);
  console.error(`[support] authenticated via one.sangfor.com Resources: ${ok}`);

  const results: string[] = [];
  for (const p of PRODUCTS) {
    const r = await downloadManual(ctx, p);
    console.error('[collect] ' + r);
    results.push(r);
  }
  console.error('\n==== SUMMARY ====\n' + results.join('\n'));
  await ctx.close();
}
main().catch((e) => { console.error('fatal', e); process.exit(1); });
