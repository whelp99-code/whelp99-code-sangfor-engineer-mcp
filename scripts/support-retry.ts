/** Retry the slow-PDF products (IAG, XDR) reusing the authenticated profile, longer timeout. */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page, type BrowserContext } from 'playwright';

const USER_DATA = '/tmp/sangfor-kb-profile';
const DEST = process.env.SANGFOR_COLLECT_DEST ?? '/Volumes/My Passport/00. Attached/_SupportDocs';
const SHOT = '/tmp/kb-login';
const DL_TIMEOUT = Number(process.env.DL_TIMEOUT ?? 320_000);

const PRODUCTS = [
  { name: 'IAG_SWG', product_id: 22, version_id: 1144, category_id: 94 },
  { name: 'XDR',     product_id: 25, version_id: 1361, category_id: 2630333 },
];
mkdirSync(DEST, { recursive: true });
const nap = (p: Page, ms: number) => p.waitForTimeout(ms);

async function dl(ctx: BrowserContext, prod: typeof PRODUCTS[number]): Promise<string> {
  const page = await ctx.newPage();
  const url = `https://support.sangfor.com/productDocument/read?product_id=${prod.product_id}&version_id=${prod.version_id}&category_id=${prod.category_id}`;
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
    await nap(page, 5000);
    const dlPromise = page.waitForEvent('download', { timeout: DL_TIMEOUT });
    await page.locator('text=/^\\s*Download\\s*$/').first().click({ timeout: 8000 });
    await nap(page, 2500);
    await page.getByRole('button', { name: /^confirm$/i }).first().click({ timeout: 6000, force: true }).catch(async () => {
      await page.locator('button:has-text("Confirm"), .el-button--primary').last().click({ timeout: 4000 }).catch(() => {});
    });
    console.error(`[${prod.name}] confirmed, waiting up to ${Math.round(DL_TIMEOUT/1000)}s for PDF parsing…`);
    const d = await dlPromise;
    const fn = d.suggestedFilename() || `${prod.name}.pdf`;
    await d.saveAs(join(DEST, `${prod.name}__UserManual__${fn}`));
    await page.close();
    return `OK   ${prod.name}: ${fn}`;
  } catch (e) {
    await page.close();
    return `FAIL ${prod.name}: ${String(e).slice(0, 120)}`;
  }
}

async function main() {
  const ctx = await chromium.launchPersistentContext(USER_DATA, {
    headless: false, channel: 'chrome', viewport: null, ignoreHTTPSErrors: true, acceptDownloads: true,
    ignoreDefaultArgs: ['--enable-automation'],
  });
  const results: string[] = [];
  for (const p of PRODUCTS) { const r = await dl(ctx, p); console.error('[retry] ' + r); results.push(r); }
  console.error('\n==== RETRY SUMMARY ====\n' + results.join('\n'));
  await ctx.close();
}
main().catch((e) => { console.error('fatal', e); process.exit(1); });
