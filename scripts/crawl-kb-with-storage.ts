/**
 * Crawl KB detail pages using tokens from .env (same as Glass browser session).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnvFile } from '../packages/sangfor-collector/src/load-env.js';
import {
  launchKbBrowser,
  prepareKbPage,
  resolveKbBrowserTokens
} from './lib/kb-browser-session.js';

loadEnvFile('.env');

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60);
}

function articleIdFromUrl(url: string): string {
  const m = url.match(/articleId%22%3A%22([^%]+)/) || url.match(/articleId":"([^"]+)/);
  return m?.[1] ?? slug(url);
}

async function main() {
  const tokens = await resolveKbBrowserTokens();
  if (!tokens.libraryToken && !tokens.tokenByCode) {
    console.error('Run pnpm run login:one:safari first');
    process.exit(1);
  }

  const arg = process.argv[2];
  const fromCatalog = arg?.endsWith('.json') && existsSync(arg);
  const seedUrl = !fromCatalog
    ? (arg ?? 'https://knowledgebase.sangfor.com/detailPage?articleData=%7B%22articleType%22%3A1,%22articleId%22%3A%2227948443021b4833bc7d6426cf56e997%22,%22keyword%22%3A%22%22%7D')
    : undefined;
  const maxPages = Number(process.env.SANGFOR_BROWSER_CRAWL_MAX ?? 120);

  const { page, close } = await launchKbBrowser(tokens);
  const ready = await prepareKbPage(tokens, page);
  if (!ready) console.error('Warning: KB may still show Login — crawl quality may be low.');

  let links: Array<{ href: string; text: string }> = [];
  if (fromCatalog && arg) {
    links = JSON.parse(readFileSync(arg, 'utf8')) as Array<{ href: string; text: string }>;
  } else if (seedUrl) {
    await page.goto(seedUrl, { waitUntil: 'networkidle', timeout: 90_000 }).catch(() => {});
    links = await page.evaluate(() => {
      const anchors = [...document.querySelectorAll('a[href*="detailPage"]')] as HTMLAnchorElement[];
      return [...new Map(anchors.map(a => [a.href, (a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120)])).entries()]
        .map(([href, text]) => ({ href, text }));
    });
  }

  const rawDir = 'data/sources/raw';
  mkdirSync(rawDir, { recursive: true });
  const visited = new Set<string>();
  const queue = [
    ...(seedUrl ? [{ href: seedUrl, text: 'Seed page' }] : []),
    ...links
  ];
  let saved = 0;

  for (const item of queue) {
    if (visited.has(item.href) || saved >= maxPages) continue;
    visited.add(item.href);
    try {
      await page.goto(item.href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForTimeout(1500);
      const data = await page.evaluate(() => {
        const app = (document.querySelector('#app') || document.body) as HTMLElement;
        const title = document.querySelector('h1,h2,.article-title')?.textContent?.trim() || document.title;
        return { url: location.href, title, text: (app.innerText || '').slice(0, 20000) };
      });
      if (!data.text || data.text.length < 200) continue;
      const id = articleIdFromUrl(data.url);
      const md = [
        '---',
        `id: browser_kb_${id}`,
        'source: knowledge_browser',
        `sourceUrl: ${data.url}`,
        'product: HCI',
        'trustLevel: official',
        `fetchedAt: ${new Date().toISOString()}`,
        '---',
        '',
        `# ${item.text || data.title}`,
        '',
        data.text
      ].join('\n');
      writeFileSync(join(rawDir, `browser_kb_${id}.md`), md, 'utf8');
      saved += 1;
      console.error(`saved ${saved}: ${item.text || id}`);
    } catch (err) {
      console.error(`skip ${item.text}: ${err}`);
    }
  }

  await close();
  console.log(JSON.stringify({ saved, queued: links.length }, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
