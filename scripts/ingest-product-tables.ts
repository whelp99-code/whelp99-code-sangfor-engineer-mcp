/**
 * Ingest sangfor_product_tables.md (KB document index by product) into RAG.
 * Usage: pnpm exec tsx scripts/ingest-product-tables.ts [path-to-md]
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnvFile } from '../packages/sangfor-collector/src/load-env.js';
import type { ProductCode } from '../packages/shared/src/index.js';
import { ingestDocument, exportRagIndexSummary } from '../packages/sangfor-rag/src/index.js';

loadEnvFile('.env');

interface CatalogRow {
  num: number;
  title: string;
  type: string;
  updated: string;
  url: string;
}

interface CatalogSection {
  productLabel: string;
  product: ProductCode;
  total: number;
  rows: CatalogRow[];
}

function mapProduct(label: string): ProductCode {
  const l = label.toLowerCase();
  if (l.includes('hci')) return 'HCI';
  if (l.includes('epp') || l.includes('endpoint')) return 'ENDPOINT_SECURE';
  if (l.includes('ndr') || l.includes('ngfw') || l.includes('xdr') || l.includes('cyber')) return 'CYBER_COMMAND';
  if (l.includes('swg') || l.includes('iag') || l.includes('atrust')) return 'IAG';
  return 'HCI';
}

function parseProductTables(md: string): CatalogSection[] {
  const sections: CatalogSection[] = [];
  const parts = md.split(/^## /m).slice(1);
  for (const part of parts) {
    const header = part.split('\n')[0]?.trim() ?? '';
    const totalMatch = header.match(/\(Total\s+(\d+)\)/i);
    const productLabel = header.replace(/\s*\(Total\s+\d+\)\s*/i, '').trim();
    const rows: CatalogRow[] = [];
    for (const line of part.split('\n')) {
      const m = line.match(/^\|\s*(\d+)\s*\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|\s*(https:\/\/[^|]+)\s*\|/);
      if (!m) continue;
      rows.push({
        num: Number(m[1]),
        title: m[2].trim(),
        type: m[3].trim(),
        updated: m[4].trim(),
        url: m[5].trim()
      });
    }
    if (rows.length) {
      sections.push({
        productLabel,
        product: mapProduct(productLabel),
        total: totalMatch ? Number(totalMatch[1]) : rows.length,
        rows
      });
    }
  }
  return sections;
}

function articleIdFromUrl(url: string): string {
  const m = url.match(/articleId%22%3A%22([^%]+)/) || url.match(/"articleId":"([^"]+)"/);
  return m?.[1] ?? 'unknown';
}

async function main() {
  const src = process.argv[2] ?? join(process.cwd(), 'data/sources/sangfor_product_tables.md');
  if (!existsSync(src)) {
    console.error(`File not found: ${src}`);
    process.exit(1);
  }

  const rawDir = 'data/sources/raw';
  const indexPath = 'data/rag/index.json';
  mkdirSync('data/sources', { recursive: true });
  mkdirSync(rawDir, { recursive: true });

  const md = readFileSync(src, 'utf8');
  const sections = parseProductTables(md);

  const urlList: Array<{ href: string; text: string; product: ProductCode }> = [];
  let ingested = 0;
  let chunks = 0;

  for (const section of sections) {
    const sectionSlug = section.productLabel.replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 40);
    const sectionMd = [
      '---',
      `id: catalog_${sectionSlug}`,
      'source: knowledge_catalog',
      'sourceUrl: https://knowledgebase.sangfor.com/home',
      `product: ${section.product}`,
      'trustLevel: official',
      `fetchedAt: ${new Date().toISOString()}`,
      '---',
      '',
      `# ${section.productLabel} — document catalog (${section.rows.length} entries)`,
      '',
      '| # | Title | Type | Last Updated | URL |',
      '|---|-------|------|-------------|-----|',
      ...section.rows.map(r =>
        `| ${r.num} | ${r.title.replace(/\|/g, '\\|')} | ${r.type} | ${r.updated} | ${r.url} |`
      )
    ].join('\n');
    const sectionPath = join(rawDir, `catalog_${sectionSlug}.md`);
    writeFileSync(sectionPath, sectionMd, 'utf8');
    const secResult = await ingestDocument({
      filePath: sectionPath,
      product: section.product,
      indexPath,
      sourceType: 'manual',
      trustLevel: 'official',
      title: section.productLabel
    });
    chunks += secResult.chunkCount;
    ingested += 1;

    for (const row of section.rows) {
      urlList.push({ href: row.url, text: row.title, product: section.product });
      const id = articleIdFromUrl(row.url);
      const rowPath = join(rawDir, `catalog_entry_${section.product}_${id}.md`);
      const rowMd = [
        '---',
        `id: catalog_entry_${id}`,
        'source: knowledge_catalog',
        `sourceUrl: ${row.url}`,
        `product: ${section.product}`,
        'trustLevel: official',
        `fetchedAt: ${new Date().toISOString()}`,
        '---',
        '',
        `# ${row.title}`,
        '',
        `- Product area: ${section.productLabel}`,
        `- Document type: ${row.type}`,
        `- Last updated: ${row.updated}`,
        `- URL: ${row.url}`,
        '',
        'Indexed from sangfor_product_tables.md (Claude KB crawl). Use URL for full document.'
      ].join('\n');
      writeFileSync(rowPath, rowMd, 'utf8');
      const rowResult = await ingestDocument({
        filePath: rowPath,
        product: section.product,
        indexPath,
        sourceType: 'manual',
        trustLevel: 'official',
        title: row.title
      });
      chunks += rowResult.chunkCount;
      ingested += 1;
    }
  }

  writeFileSync('data/sources/product-tables-urls.json', JSON.stringify(urlList, null, 2), 'utf8');

  console.log(JSON.stringify({
    source: src,
    sections: sections.map(s => ({ label: s.productLabel, product: s.product, rows: s.rows.length })),
    filesIngested: ingested,
    chunks,
    urlsExported: urlList.length,
    urlListPath: 'data/sources/product-tables-urls.json',
    rag: exportRagIndexSummary(indexPath)
  }, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
