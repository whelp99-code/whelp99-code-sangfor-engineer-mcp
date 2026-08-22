/**
 * Ad-hoc scoped collector: HCI (product 10) + SCP (product 45) support-site
 * documentation, filtered to category leaves that look like API or CLI
 * manuals. NOT the full two-site crawler — targeted, small, fast.
 *
 * Usage: pnpm exec tsx scripts/collect-hci-scp-docs.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';
import {
  flattenSupportLeaves,
  parseSupportProductVersions,
  type SupportLeaf
} from '../packages/sangfor-collector/src/site-learning-crawler.js';
import { canonicalizeLearningUrl } from '../packages/sangfor-collector/src/learning-sites.js';
import { ingestDocumentsBatch } from '../packages/sangfor-rag/src/index.js';

const SUPPORT_BASE = 'https://support.sangfor.com';
const RAW_DIR = 'data/sources/raw/hci-scp-api-cli';
const REPORT_PATH = 'data/sources/hci-scp-api-cli-report.json';
const RAG_INDEX_PATH = process.env.SANGFOR_RAG_INDEX_PATH ?? 'data/rag/index.json';

// Chosen from the live productVersion catalog (queried 2026-08-16):
// 10 = Hyper Converged Infrastructure (HCI/aSV), 45 = Sangfor Cloud Platform (SCP)
const TARGETS: Array<{ productId: number; versionId: number; label: string; product: 'HCI_SCP' }> = [
  { productId: 10, versionId: 1381, label: 'HCI 6.11.3', product: 'HCI_SCP' },
  { productId: 45, versionId: 1388, label: 'SCP 6.12.0', product: 'HCI_SCP' }
];

const API_CLI_PATTERN = /\bapi\b|\bcli\b|command[- ]line|command line interface|restful|openapi|\bsdk\b|shell command/i;

interface CollectedDoc {
  id: string;
  productLabel: string;
  categoryPath: string;
  sourceUrl: string;
  title: string;
  text: string;
}

function safeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

async function pageText(page: Page): Promise<{ title: string; text: string; url: string }> {
  return page.evaluate(() => {
    const candidates = [
      '.doc-content', '.html-content', '.rich-text', '.article-detail',
      '.detail-page', '#ct', 'article', 'main', '#app', 'body'
    ];
    let best: HTMLElement | null = null;
    for (const selector of candidates) {
      for (const element of document.querySelectorAll<HTMLElement>(selector)) {
        if (!best || element.innerText.length > best.innerText.length) best = element;
      }
    }
    const heading = document.querySelector('h1,h2,.article-title,.ts h1');
    return {
      title: (heading?.textContent || document.title || location.href).replace(/\s+/g, ' ').trim(),
      text: (best?.innerText || document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 100_000),
      url: location.href
    };
  });
}

async function rootCategoryIds(page: Page, productId: number, versionId: number): Promise<number[]> {
  const entryUrl = `${SUPPORT_BASE}/productDocument/read?product_id=${productId}&version_id=${versionId}&type=1`;
  await page.goto(entryUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(1_000);
  const viaVue = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('*')]
      .flatMap((element) => {
        const value = (element as HTMLElement & { __vue__?: { linkTreeData?: Array<{ id: number }> } }).__vue__?.linkTreeData;
        return Array.isArray(value) ? value.map((node) => node.id) : [];
      })
      .filter((id) => Number.isInteger(id) && id > 0));
  if (viaVue.length) return [...new Set(viaVue)];
  const viaAnchors = await page.evaluate(({ pid, vid }: { pid: number; vid: number }) =>
    [...document.querySelectorAll<HTMLAnchorElement>('a[href*="productDocument/read"]')]
      .filter((link) => {
        const url = new URL(link.href, location.href);
        return Number(url.searchParams.get('product_id')) === pid && Number(url.searchParams.get('version_id')) === vid;
      })
      .map((link) => Number(new URL(link.href, location.href).searchParams.get('category_id')))
      .filter((id) => Number.isInteger(id) && id > 0), { pid: productId, vid: versionId });
  return [...new Set(viaAnchors)];
}

async function collectForTarget(
  page: Page,
  target: (typeof TARGETS)[number]
): Promise<CollectedDoc[]> {
  const roots = await rootCategoryIds(page, target.productId, target.versionId);
  const matchedLeaves: SupportLeaf[] = [];
  for (const rootId of roots) {
    try {
      const response = await page.request.get(
        `${SUPPORT_BASE}/ProductDocument/leftCategories?product_id=${target.productId}`
        + `&doc_type=1&category_id=${rootId}&version_id=${target.versionId}`,
        { timeout: 60_000 }
      );
      const payload = await response.json() as { data?: Parameters<typeof flattenSupportLeaves>[0] };
      const leaves = flattenSupportLeaves(payload.data ?? []);
      for (const leaf of leaves) {
        if (API_CLI_PATTERN.test(leaf.path.join(' / '))) matchedLeaves.push(leaf);
      }
    } catch (error) {
      console.error(`[collect] leftCategories failed for root ${rootId}: ${String(error)}`);
    }
  }

  const seen = new Set<string>();
  const docs: CollectedDoc[] = [];
  for (const leaf of matchedLeaves) {
    const url = canonicalizeLearningUrl(
      `${SUPPORT_BASE}/productDocument/read?product_id=${target.productId}`
      + `&version_id=${target.versionId}&category_id=${leaf.categoryId}&type=1`
    );
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      const extracted = await pageText(page);
      if (extracted.text.length < 120) continue; // login shell / empty page
      docs.push({
        id: `hci_scp_${target.productId}_${target.versionId}_${leaf.categoryId}`,
        productLabel: target.label,
        categoryPath: leaf.path.join(' / '),
        sourceUrl: canonicalizeLearningUrl(extracted.url),
        title: `${target.label} - ${leaf.path.join(' / ')}`,
        text: extracted.text
      });
      console.error(`[collect] ${target.label}: ${leaf.path.join(' / ')} (${extracted.text.length} chars)`);
    } catch (error) {
      console.error(`[collect] fetch failed for ${url}: ${String(error)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return docs;
}

async function main(): Promise<void> {
  mkdirSync(RAW_DIR, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  const allDocs: CollectedDoc[] = [];
  try {
    // Sanity check the live catalog still resolves the chosen product/version ids.
    const catalogResponse = await page.request.post(`${SUPPORT_BASE}/product/productVersion`, { timeout: 60_000 });
    const catalog = parseSupportProductVersions(await catalogResponse.json());
    for (const target of TARGETS) {
      const stillListed = catalog.some((v) => v.productId === target.productId && v.versionId === target.versionId);
      if (!stillListed) console.error(`[collect] WARNING: ${target.label} (product ${target.productId}, version ${target.versionId}) not found in live catalog`);
    }

    for (const target of TARGETS) {
      const docs = await collectForTarget(page, target);
      allDocs.push(...docs);
    }
  } finally {
    await context.close();
    await browser.close();
  }

  const files: string[] = [];
  for (const doc of allDocs) {
    const path = join(RAW_DIR, `${safeId(doc.id)}.md`);
    writeFileSync(path, `# ${doc.title}\n\nSource: ${doc.sourceUrl}\n\n${doc.text}\n`, 'utf8');
    files.push(path);
  }

  const ingested = files.length
    ? await ingestDocumentsBatch(files.map((filePath, index) => ({
        filePath,
        product: 'HCI_SCP',
        indexPath: RAG_INDEX_PATH,
        sourceType: 'manual',
        trustLevel: 'official',
        title: allDocs[index].title
      })))
    : { chunkCount: 0 };

  const report = {
    collectedAt: new Date().toISOString(),
    targets: TARGETS.map((t) => `${t.label} (product ${t.productId}, version ${t.versionId})`),
    filterPattern: API_CLI_PATTERN.source,
    documentsFound: allDocs.length,
    chunksIngested: ingested.chunkCount,
    documents: allDocs.map((d) => ({
      productLabel: d.productLabel,
      categoryPath: d.categoryPath,
      sourceUrl: d.sourceUrl,
      title: d.title,
      chars: d.text.length
    }))
  };
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({ documentsFound: allDocs.length, chunksIngested: ingested.chunkCount, reportPath: REPORT_PATH }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
