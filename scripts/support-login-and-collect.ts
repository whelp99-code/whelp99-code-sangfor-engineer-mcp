/**
 * Interactive: opens one.sangfor.com in a headed window. The user logs in
 * (partner lyndon.bear) and navigates Resources → Sangfor Support. This script
 * polls until support.sangfor.com is authenticated, then downloads the priority
 * product User Manual PDFs into the drive using the same session.
 *
 *   pnpm exec tsx scripts/support-login-and-collect.ts
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page, type BrowserContext } from 'playwright';

const USER_DATA = '/tmp/sangfor-kb-profile';
const DEST = process.env.SANGFOR_COLLECT_DEST ?? '/Volumes/My Passport/00. Attached/_SupportDocs';
const SHOT = '/tmp/kb-login';
const POLL_MS = Number(process.env.LOGIN_POLL_MS ?? 420_000);

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

/** Authenticated if the support home no longer shows a top-right "Log in" entry. */
async function supportAuthed(ctx: BrowserContext): Promise<boolean> {
  const p = await ctx.newPage();
  try {
    await p.goto('https://support.sangfor.com/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await p.waitForTimeout(2500);
    const loginCount = await p.locator('text=/^\\s*Log in\\s*$/i').count().catch(() => 1);
    await p.close();
    return loginCount === 0;
  } catch { await p.close().catch(() => {}); return false; }
}

async function downloadManual(ctx: BrowserContext, prod: typeof PRODUCTS[number]): Promise<string> {
  const page = await ctx.newPage();
  const url = `https://support.sangfor.com/productDocument/read?product_id=${prod.product_id}&version_id=${prod.version_id}&category_id=${prod.category_id}`;
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
    await nap(page, 5000);
    const dlPromise = page.waitForEvent('download', { timeout: 150000 });
    await page.locator('text=/^\\s*Download\\s*$/').first().click({ timeout: 8000 });
    await nap(page, 2500);
    await page.getByRole('button', { name: /^confirm$/i }).first().click({ timeout: 6000, force: true }).catch(async () => {
      await page.locator('button:has-text("Confirm"), .el-button--primary').last().click({ timeout: 4000 }).catch(() => {});
    });
    const dl = await dlPromise;
    const fn = dl.suggestedFilename() || `${prod.name}.pdf`;
    await dl.saveAs(join(DEST, `${prod.name}__UserManual__${fn}`));
    await page.close();
    return `OK   ${prod.name}: ${fn}`;
  } catch (e) {
    await page.screenshot({ path: join(SHOT, `fail_${prod.name}.png`) }).catch(() => {});
    await page.close();
    return `FAIL ${prod.name}: ${String(e).slice(0, 120)}`;
  }
}

async function main() {
  const ctx = await chromium.launchPersistentContext(USER_DATA, {
    headless: false, channel: 'chrome', viewport: null, args: ['--start-maximized'],
    ignoreHTTPSErrors: true, acceptDownloads: true, ignoreDefaultArgs: ['--enable-automation'],
  });
  const page = ctx.pages()[0] ?? await ctx.newPage();
  await page.goto('https://one.sangfor.com', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  console.error('┌───────────────────────────────────────────────────────────────┐');
  console.error('│ ACTION NEEDED IN THE BROWSER WINDOW:                            │');
  console.error('│  1) Login → Partner Login (Non EMEA) → lyndon.bear account      │');
  console.error('│  2) Resources → Sangfor Support (support.sangfor.com opens)     │');
  console.error('│ Then leave it — I will auto-detect and start downloading.       │');
  console.error('└───────────────────────────────────────────────────────────────┘');

  const deadline = Date.now() + POLL_MS;
  let authed = false;
  while (Date.now() < deadline) {
    if (await supportAuthed(ctx)) { authed = true; break; }
    await page.waitForTimeout(5000);
  }
  console.error(`[support] authenticated: ${authed}`);
  if (!authed) { console.error('[support] timed out waiting for login. Re-run when logged in.'); await ctx.close(); return; }

  const results: string[] = [];
  for (const prod of PRODUCTS) {
    const r = await downloadManual(ctx, prod);
    console.error('[collect] ' + r);
    results.push(r);
  }
  console.error('\n==== SUMMARY ====\n' + results.join('\n'));
  await ctx.close();
}
main().catch((e) => { console.error('fatal', e); process.exit(1); });
