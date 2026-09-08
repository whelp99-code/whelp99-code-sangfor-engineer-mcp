import type { Page } from 'playwright';
import { inferProductFromText } from '../../packages/sangfor-collector/src/index.js';
import type { ProductCode } from '../../packages/shared/src/index.js';
import { readSafariLibraryTree } from './kb-browser-session.js';
import {
  articleIdFromUrl,
  type ProductTableEntry
} from './parse-product-tables.js';

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

export function dedupeEntries(entries: KbPageEntry[]): KbPageEntry[] {
  const deduped = new Map<string, KbPageEntry>();
  for (const entry of entries) {
    const id = entry.articleId || articleIdFromUrl(entry.url);
    if (!id) continue;
    entry.articleId = id;
    if (!deduped.has(id)) deduped.set(id, entry);
  }
  return [...deduped.values()];
}

export async function discoverSiteMap(page: Page, seeds: KbPageEntry[]): Promise<KbPageEntry[]> {
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
