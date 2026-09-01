import type { Page } from 'playwright';
import { articleIdFromUrl } from './parse-product-tables.js';
import type { KbPageEntry } from './kb-full-site-discovery.js';

type CrawlPageBodiesOptions = {
  readonly page: Page;
  readonly entries: KbPageEntry[];
  readonly maxPages: number;
  readonly saveBody: (id: string, markdown: string) => void;
};

export async function crawlAndRenderPageBodies(options: CrawlPageBodiesOptions): Promise<number> {
  let saved = 0;
  const visited = new Set<string>();

  for (const entry of options.entries) {
    if (visited.has(entry.url) || saved >= options.maxPages) continue;
    visited.add(entry.url);
    try {
      await options.page.goto(entry.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await options.page.waitForTimeout(1200);
      const data = await options.page.evaluate(() => {
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

      options.saveBody(id, md);
      saved += 1;
      if (saved % 10 === 0) {
        console.error(`crawled ${saved}/${Math.min(options.entries.length, options.maxPages)}`);
      }
    } catch (err) {
      console.error(`skip ${entry.title}: ${err}`);
    }
  }
  return saved;
}
