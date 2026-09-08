import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProductCode as PC } from '../../packages/shared/src/index.js';
import { ingestDocument, exportRagIndexSummary } from '../../packages/sangfor-rag/src/index.js';
import type { KbPageEntry } from './kb-full-site-discovery.js';

export function renderProductTablesMd(entries: KbPageEntry[]): string {
  const bySection = new Map<string, KbPageEntry[]>();
  for (const entry of entries) {
    const key = entry.section.split('\n')[0]?.trim() || 'General';
    const rows = bySection.get(key);
    if (rows) rows.push(entry);
    else bySection.set(key, [entry]);
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
    rows.forEach((row, index) => {
      lines.push(
        `| ${index + 1} | ${row.title.replace(/\|/g, '\\|')} | ${row.type.replace(/\|/g, '\\|')} | ${row.updated.replace(/\|/g, '\\|')} | ${row.url} |`
      );
    });
    lines.push('');
  }

  return lines.join('\n');
}

export async function ingestCrawledPages(rawDir: string) {
  let chunks = 0;
  const indexPath = 'data/rag/index.json';
  const files = readdirSync(rawDir).filter(file => file.startsWith('kb_site_') && file.endsWith('.md'));
  for (const file of files) {
    const path = join(rawDir, file);
    const product = (readFileSync(path, 'utf8').match(/^product:\s*(\w+)/m)?.[1] ?? 'HCI') as PC;
    const result = await ingestDocument({
      filePath: path,
      product,
      indexPath,
      sourceType: 'manual',
      trustLevel: 'official',
      title: file.replace('.md', '')
    });
    chunks += result.chunkCount;
  }

  return {
    filesIngested: files.length,
    chunks,
    rag: exportRagIndexSummary(indexPath)
  };
}
