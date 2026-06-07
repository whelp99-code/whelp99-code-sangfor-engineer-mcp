/**
 * Full Knowledge Base learning: site map (product tables + browser discovery) + crawl + RAG.
 *
 * Usage:
 *   pnpm run login:one:safari
 *   pnpm run learn:kb:full
 *
 * Optional:
 *   SANGFOR_CDP_URL=http://127.0.0.1:9222  — reuse Glass/Chrome logged-in tab
 *   SANGFOR_KB_HEADED=1                   — visible browser for SSO
 *   SANGFOR_KB_FULL_MAX=200               — cap crawl pages
 *   --crawl-only                          — skip discovery, use kb-site-map.json
 *   --discover-only                       — build site map only
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { loadEnvFile } from '../packages/sangfor-collector/src/load-env.js';
import { inferProductFromText } from '../packages/sangfor-collector/src/index.js';
import type { ProductCode, ProductCode as PC } from '../packages/shared/src/index.js';
import { ingestDocument, exportRagIndexSummary } from '../packages/sangfor-rag/src/index.js';
import {
  launchKbBrowser,
  prepareKbPage,
  readSafariLibraryTree,
  resolveKbBrowserTokens,
  type KbBrowserTokens
} from './lib/kb-browser-session.js';
import {
  articleIdFromUrl,
  loadProductTableSeeds,
  type ProductTableEntry
} from './lib/parse-product-tables.js';

loadEnvFile('.env');

export type KbPageEntry = ProductTableEntry;

function mapSectionToProduct(section: string): ProductCode {
  return inferProductFromText(section, 'HCI');
}

async function collectLinksOnPage(page: Page, section: string): Promise<Omit<KbPageEntry, 'product'>[]> {
  return page.evaluate((sec) => {
    const rows: Array<{
      section: string;
      title: string;
      type: string;
      updated: string;
      url: string;
      articleId: string;
    }> = [];
    const seen = new Set<string>();

    function add(href: string, title: string, type = 'Document', updated = '') {
      if (!href.includes('detailPage') || !href.includes('articleId')) return;
      const idMatch = href.match(/articleId%22%3A%22([^%]+)/);
      const id = idMatch ? idMatch[1] : '';
      if (!id || seen.has(id)) return;
      seen.add(id);
      rows.push({
        section: sec,
        title: title.replace(/\s+/g, ' ').trim().slice(0, 200),
        type,
        updated,
        url: href,
        articleId: id
      });
    }

    document.querySelectorAll('a[href*="detailPage"]').forEach(a => {
      add((a as HTMLAnchorElement).href, (a.textContent || '').trim());
    });

    document.querySelectorAll('tr').forEach(tr => {
      const link = tr.querySelector('a[href*="detailPage"]') as HTMLAnchorElement | null;
      if (!link) return;
      const cells = [...tr.querySelectorAll('td')].map(td => (td.textContent || '').trim());
      add(link.href, cells[0] || link.textContent || '', cells[1] || 'Document', cells[2] || '');
    });

    return rows;
  }, section);
}

async function discoverHomeProductLabels(page: Page): Promise<string[]> {
  await page.goto('https://knowledgebase.sangfor.com/home', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(2000);
  return page.evaluate(() => {
    const skip = new Set([
      'Visit Sangfor Support', 'Email Us', 'Select', 'Search documents or hardware',
      'Login', 'Log out', 'Logout', 'Home', 'EN', '中文'
    ]);
    const names: string[] = [];
    const candidates = document.querySelectorAll(
      '.home-page button, .home-page .el-button, .home-page [class*="product"] span, .home-page [class*="card"]'
    );
    candidates.forEach(el => {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!t || skip.has(t) || t.length > 55 || t.length < 2) return;
      if (/^Sangfor /i.test(t) && t.length > 35) return;
      names.push(t);
    });
    return [...new Set(names)];
  });
}

async function clickProductLabel(page: Page, label: string): Promise<boolean> {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const locators = [
    page.getByRole('button', { name: new RegExp(`^${escaped}$`, 'i') }),
    page.locator('.home-page').getByText(label, { exact: true }),
    page.getByText(label, { exact: true })
  ];
  for (const loc of locators) {
    if (!(await loc.count())) continue;
    await loc.first().click({ timeout: 12_000 }).catch(() => {});
    await page.waitForTimeout(2500);
    return true;
  }
  return false;
}

function parseLibraryTree(json: string, section: string): KbPageEntry[] {
  const entries: KbPageEntry[] = [];
  const seen = new Set<string>();
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return entries;
  }

  function walk(node: unknown, ctx: string): void {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(n => walk(n, ctx));
      return;
    }
    const o = node as Record<string, unknown>;
    const name = String(o.name ?? o.title ?? o.label ?? '');
    const link = String(o.link ?? o.url ?? o.path ?? '');
    const nextCtx = name ? `${ctx} ${name}` : ctx;

    if (link.includes('articleData=') || link.includes('articleId')) {
      const full = link.startsWith('http')
        ? link
        : `https://knowledgebase.sangfor.com${link.startsWith('/') ? link : `/${link}`}`;
      const id = articleIdFromUrl(full);
      if (id && !seen.has(id)) {
        seen.add(id);
        entries.push({
          section: section || nextCtx.trim(),
          title: name || `Article ${id}`,
          type: String(o.type ?? o.docType ?? 'Document'),
          updated: String(o.updateTime ?? o.updated ?? ''),
          url: full,
          product: mapSectionToProduct(`${section} ${nextCtx}`),
          articleId: id
        });
      }
    }
    for (const v of Object.values(o)) walk(v, nextCtx);
  }

  walk(data, section);
  return entries;
}

function dedupeEntries(entries: KbPageEntry[]): KbPageEntry[] {
  const deduped = new Map<string, KbPageEntry>();
  for (const e of entries) {
    const id = e.articleId || articleIdFromUrl(e.url);
    if (!id) continue;
    e.articleId = id;
    if (!deduped.has(id)) deduped.set(id, e);
  }
  return [...deduped.values()];
}

function writeProductTablesMd(entries: KbPageEntry[], path: string): void {
  const bySection = new Map<string, KbPageEntry[]>();
  for (const e of entries) {
    const key = e.section.split('\n')[0]?.trim() || 'General';
    if (!bySection.has(key)) bySection.set(key, []);
    bySection.get(key)!.push(e);
  }

  const lines = [
    '# Product Document Summary Tables',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    'Source: https://knowledgebase.sangfor.com (site map + product table seeds)',
    ''
  ];

  for (const [section, rows] of [...bySection.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`## ${section} (Total ${rows.length})`, '');
    lines.push('| # | Title | Type | Last Updated | URL |');
    lines.push('|---|-------|------|-------------|-----|');
    rows.forEach((r, i) => {
      lines.push(
        `| ${i + 1} | ${r.title.replace(/\|/g, '\\|')} | ${r.type.replace(/\|/g, '\\|')} | ${r.updated.replace(/\|/g, '\\|')} | ${r.url} |`
      );
    });
    lines.push('');
  }

  writeFileSync(path, lines.join('\n'), 'utf8');
}

async function discoverSiteMap(page: Page, seeds: KbPageEntry[]): Promise<KbPageEntry[]> {
  const entries: KbPageEntry[] = [...seeds];

  const safariTree = readSafariLibraryTree();
  if (safariTree) {
    const fromSafari = parseLibraryTree(safariTree, 'Safari library_tree');
    entries.push(...fromSafari);
    console.error(`Safari library_tree: +${fromSafari.length} articles`);
  }

  const treeInPage = await page.evaluate(() => localStorage.getItem('library_tree'));
  if (treeInPage && treeInPage.length > 100) {
    const fromPage = parseLibraryTree(treeInPage, 'library_tree');
    entries.push(...fromPage);
    console.error(`Browser library_tree: +${fromPage.length} articles`);
  }

  const productLabels = await discoverHomeProductLabels(page);
  console.error(`Home product tiles: ${productLabels.length}`);

  for (const label of productLabels) {
    await page.goto('https://knowledgebase.sangfor.com/home', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const clicked = await clickProductLabel(page, label);
    if (!clicked) continue;

    const fromPage = await collectLinksOnPage(page, label);
    entries.push(
      ...fromPage.map(row => ({
        ...row,
        product: mapSectionToProduct(`${label} ${row.title}`)
      }))
    );
    console.error(`  ${label}: +${fromPage.length} links`);

    const treeRaw = await page.evaluate(() => localStorage.getItem('library_tree'));
    if (treeRaw && treeRaw.length > 100) {
      const fromTree = parseLibraryTree(treeRaw, label);
      entries.push(...fromTree);
      console.error(`  ${label}: +${fromTree.length} from library_tree`);
    }
  }

  const navSections = ['Sales', 'Marketing', 'Technical Material', 'Products', 'Solutions'];
  for (const nav of navSections) {
    await page.goto('https://knowledgebase.sangfor.com/home', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const link = page.locator('.el-menu-item, [class*="menu"]').filter({ hasText: new RegExp(`^${nav}$`) }).first();
    if (!(await link.count())) continue;
    await link.click({ timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(2000);
    const fromNav = await collectLinksOnPage(page, nav);
    entries.push(
      ...fromNav.map(row => ({
        ...row,
        product: mapSectionToProduct(`${nav} ${row.title}`)
      }))
    );
    console.error(`  nav ${nav}: +${fromNav.length}`);
  }

  return dedupeEntries(entries);
}

async function crawlPageBodies(
  page: Page,
  entries: KbPageEntry[],
  rawDir: string,
  maxPages: number
): Promise<number> {
  let saved = 0;
  const visited = new Set<string>();

  for (const entry of entries) {
    if (visited.has(entry.url) || saved >= maxPages) continue;
    visited.add(entry.url);
    try {
      await page.goto(entry.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForTimeout(1200);
      const data = await page.evaluate(() => {
        const root = document.querySelector('.article-detail, .detail-page, .content-detail, #app') || document.body;
        const h = document.querySelector('h1,h2,.article-title');
        return {
          url: location.href,
          title: (h?.textContent || document.title || '').trim(),
          text: (root.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 25000)
        };
      });
      if (!data.text || data.text.length < 150) continue;
      if (/^\s*Login\s*$/i.test(data.text.slice(0, 300)) && data.text.length < 2000) continue;

      const id = entry.articleId || articleIdFromUrl(data.url);
      const md = [
        '---',
        `id: kb_site_${id}`,
        'source: knowledge_browser',
        `sourceUrl: ${data.url}`,
        `product: ${entry.product}`,
        'trustLevel: official',
        `fetchedAt: ${new Date().toISOString()}`,
        '---',
        '',
        `# ${entry.title || data.title}`,
        '',
        `- Section: ${entry.section}`,
        `- Type: ${entry.type}`,
        entry.updated ? `- Last updated: ${entry.updated}` : '',
        '',
        data.text
      ].filter(Boolean).join('\n');

      writeFileSync(join(rawDir, `kb_site_${id}.md`), md, 'utf8');
      saved += 1;
      if (saved % 10 === 0) console.error(`crawled ${saved}/${Math.min(entries.length, maxPages)}`);
    } catch (err) {
      console.error(`skip ${entry.title}: ${err}`);
    }
  }
  return saved;
}

async function main() {
  const tokens = await resolveKbBrowserTokens();
  if (!tokens.libraryToken && !tokens.tokenByCode) {
    console.error('Missing KB token. Run: pnpm run login:one:safari (or open KB in Glass + SANGFOR_CDP_URL)');
    process.exit(1);
  }

  const maxPages = Number(process.env.SANGFOR_KB_FULL_MAX ?? 0) || Infinity;
  const skipDiscover = process.argv.includes('--crawl-only');
  const discoverOnly = process.argv.includes('--discover-only');
  const dataDir = 'data/sources';
  const rawDir = join(dataDir, 'raw');
  mkdirSync(rawDir, { recursive: true });
  const mapPath = join(dataDir, 'kb-site-map.json');
  const tablesPath = join(dataDir, 'sangfor_product_tables.md');

  const seedPaths = [
    tablesPath,
    join(process.env.HOME ?? '', 'Downloads/sangfor_product_tables.md')
  ].filter(p => existsSync(p));
  const seeds = loadProductTableSeeds(seedPaths);
  console.error(`Seed URLs from product tables: ${seeds.length}`);

  let entries: KbPageEntry[] = [];

  if (skipDiscover && existsSync(mapPath)) {
    entries = JSON.parse(readFileSync(mapPath, 'utf8')) as KbPageEntry[];
  } else {
    const { browser, page, close } = await launchKbBrowser(tokens);
    const ready = await prepareKbPage(tokens, page);
    if (!ready) {
      console.error(
        'KB session not ready in Playwright (still on Login). Try: SANGFOR_KB_HEADED=1 pnpm run learn:kb:full, or log in via Glass and set SANGFOR_CDP_URL.'
      );
      if (seeds.length) {
        console.error(`Falling back to ${seeds.length} seeded URLs only.`);
        entries = dedupeEntries(seeds);
      } else {
        await close();
        process.exit(2);
      }
    } else {
      entries = await discoverSiteMap(page, seeds);
      await close();
    }

    if (entries.length === 0 && seeds.length) {
      entries = dedupeEntries(seeds);
    }

    writeFileSync(mapPath, JSON.stringify(entries, null, 2), 'utf8');
    if (entries.length > 0) {
      writeProductTablesMd(entries, tablesPath);
      writeFileSync(
        join(dataDir, 'product-tables-urls.json'),
        JSON.stringify(entries.map(e => ({ href: e.url, text: e.title, product: e.product })), null, 2),
        'utf8'
      );
    }
  }

  console.error(`Site map: ${entries.length} unique articles`);

  if (discoverOnly) {
    console.log(JSON.stringify({ siteMapArticles: entries.length, siteMapFile: mapPath, tablesFile: tablesPath }, null, 2));
    return;
  }

  if (entries.length === 0) {
    console.error('No articles to crawl.');
    process.exit(1);
  }

  const { page: crawlPage, close: closeCrawl } = await launchKbBrowser(tokens);
  await prepareKbPage(tokens, crawlPage);
  const saved = await crawlPageBodies(crawlPage, entries, rawDir, maxPages);
  await closeCrawl();

  let chunks = 0;
  const indexPath = 'data/rag/index.json';
  const files = readdirSync(rawDir).filter(f => f.startsWith('kb_site_') && f.endsWith('.md'));
  for (const file of files) {
    const path = join(rawDir, file);
    const product = (readFileSync(path, 'utf8').match(/^product:\s*(\w+)/m)?.[1] ?? 'HCI') as PC;
    const r = await ingestDocument({
      filePath: path,
      product,
      indexPath,
      sourceType: 'manual',
      trustLevel: 'official',
      title: file.replace('.md', '')
    });
    chunks += r.chunkCount;
  }

  console.log(JSON.stringify({
    siteMapArticles: entries.length,
    seedUrls: seeds.length,
    pagesCrawled: saved,
    tablesFile: tablesPath,
    siteMapFile: mapPath,
    filesIngested: files.length,
    chunks,
    rag: exportRagIndexSummary(indexPath)
  }, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
