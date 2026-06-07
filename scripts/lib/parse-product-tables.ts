import { readFileSync } from 'node:fs';
import { inferProductFromText } from '../../packages/sangfor-collector/src/index.js';
import type { ProductCode } from '../../packages/shared/src/index.js';

export interface ProductTableEntry {
  section: string;
  title: string;
  type: string;
  updated: string;
  url: string;
  product: ProductCode;
  articleId: string;
}

export function articleIdFromUrl(url: string): string {
  const m = url.match(/articleId%22%3A%22([^%]+)/) || url.match(/"articleId":"([^"]+)"/);
  return m?.[1] ?? '';
}

export function parseProductTablesMd(md: string): ProductTableEntry[] {
  const entries: ProductTableEntry[] = [];
  const parts = md.split(/^## /m).slice(1);
  for (const part of parts) {
    const header = part.split('\n')[0]?.trim() ?? '';
    const section = header.replace(/\s*\(Total\s+\d+\)\s*/i, '').trim();
    if (!section) continue;
    for (const line of part.split('\n')) {
      const m = line.match(/^\|\s*\d+\s*\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|\s*(https:\/\/[^|]+)\s*\|/);
      if (!m) continue;
      const url = m[4].trim();
      const articleId = articleIdFromUrl(url);
      if (!articleId) continue;
      entries.push({
        section,
        title: m[1].trim(),
        type: m[2].trim(),
        updated: m[3].trim(),
        url,
        product: inferProductFromText(section, 'HCI'),
        articleId
      });
    }
  }
  return entries;
}

export function loadProductTableSeeds(paths: string[]): ProductTableEntry[] {
  const all: ProductTableEntry[] = [];
  for (const path of paths) {
    try {
      all.push(...parseProductTablesMd(readFileSync(path, 'utf8')));
    } catch {
      // skip missing
    }
  }
  return all;
}
