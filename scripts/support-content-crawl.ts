/**
 * Crawl support.sangfor.com product User Manual content (client-rendered) into
 * markdown files on the drive. For products whose whole-manual PDF export times out
 * (IAG, XDR), this captures the full manual section-by-section as text (RAG-ready).
 *
 *   pnpm exec tsx scripts/support-content-crawl.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';

const DEST = process.env.SANGFOR_COLLECT_DEST ?? '/Volumes/My Passport/00. Attached/_SupportDocs';
const SHOT = '/tmp/kb-login';
mkdirSync(SHOT, { recursive: true });

const PRODUCTS = [
  { name: 'IAG_SWG_13.0.120', product_id: 22, version_id: 1144, category_id: 94 },
  { name: 'XDR_3.0.98',       product_id: 25, version_id: 1361, category_id: 2630333 },
];

type Node = { id: number; name: string; children?: Node[] };
type Leaf = { id: number; path: string[] };

function flattenLeaves(nodes: Node[], trail: string[] = []): Leaf[] {
  const out: Leaf[] = [];
  for (const n of nodes) {
    const p = [...trail, n.name];
    if (n.children && n.children.length) out.push(...flattenLeaves(n.children, p));
    else out.push({ id: n.id, path: p });
  }
  return out;
}

const safe = (s: string) => s.replace(/[^\w가-힣().-]+/g, '_').slice(0, 70);

async function extractContent(page: Page): Promise<string> {
  return page.evaluate(() => {
    const sels = ['.doc-content', '.html-content', '.rich-text', '[class*="markdown"]', 'article'];
    let best: HTMLElement | null = null;
    for (const s of sels) { const el = document.querySelector(s) as HTMLElement | null; if (el && (!best || el.innerText.length > best.innerText.length)) best = el; }
    return best ? best.innerText.trim() : '';
  });
}

async function crawlProduct(page: Page, prod: typeof PRODUCTS[number]) {
  const navUrl = `https://support.sangfor.com/ProductDocument/leftCategories?product_id=${prod.product_id}&doc_type=1&category_id=${prod.category_id}&version_id=${prod.version_id}`;
  const res = await page.request.get(navUrl, { timeout: 30000 });
  const tree = (await res.json()).data as Node[];
  const leaves = flattenLeaves(tree);
  const dir = join(DEST, `${prod.name}__UserManual_content`);
  mkdirSync(dir, { recursive: true });
  console.error(`[${prod.name}] ${leaves.length} leaf sections → ${dir}`);

  let saved = 0, empty = 0, idx = 0;
  for (const leaf of leaves) {
    idx++;
    const url = `https://support.sangfor.com/productDocument/read?product_id=${prod.product_id}&version_id=${prod.version_id}&category_id=${leaf.id}`;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
      await page.waitForTimeout(1400);
      const text = await extractContent(page);
      if (text.length < 40) { empty++; continue; }
      const heading = leaf.path.join(' / ');
      const md = `# ${heading}\n\n> Sangfor Support — ${prod.name} — category_id=${leaf.id}\n> ${url}\n\n${text}\n`;
      writeFileSync(join(dir, `${String(idx).padStart(3, '0')}__${safe(leaf.path[leaf.path.length - 1])}.md`), md);
      saved++;
    } catch { empty++; }
    if (idx % 25 === 0) console.error(`[${prod.name}] ${idx}/${leaves.length} (saved ${saved})`);
    await page.waitForTimeout(250);
  }
  return `${prod.name}: saved ${saved}/${leaves.length} (empty ${empty})`;
}

async function main() {
  const b = await chromium.launch({ headless: true, channel: 'chrome' });
  const c = await b.newContext({ ignoreHTTPSErrors: true });
  const page = await c.newPage();
  const summary: string[] = [];
  for (const prod of PRODUCTS) { summary.push(await crawlProduct(page, prod)); }
  console.error('\n==== CONTENT CRAWL SUMMARY ====\n' + summary.join('\n'));
  await b.close();
}
main().catch((e) => { console.error('fatal', e); process.exit(1); });
