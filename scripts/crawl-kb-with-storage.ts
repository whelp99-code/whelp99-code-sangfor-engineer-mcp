/**
 * Crawl KB detail pages using tokens from .env (same as Glass browser session).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { loadEnvFile } from '../packages/sangfor-collector/src/load-env.js';
import { withKbBrowser } from './lib/kb-browser-session.js';
import { parseBoundaryCrawlCatalogV1 } from './lib/kb-runtime-boundaries.js';
import { kbDataDir, liveKbScriptSession, type KbScriptSession } from './lib/kb-script-runtime.js';

loadEnvFile('.env');

const SEED_FALLBACK_URL =
  'https://knowledgebase.sangfor.com/detailPage?articleData=%7B%22articleType%22%3A1,%22articleId%22%3A%2227948443021b4833bc7d6426cf56e997%22,%22keyword%22%3A%22%22%7D';

export interface CrawlKbLink {
  readonly href: string;
  readonly text: string;
}

export type CrawlKbPlan =
  | { readonly kind: 'catalog'; readonly links: readonly CrawlKbLink[] }
  | { readonly kind: 'seed'; readonly seedUrl: string };

export interface CrawlKbSummary {
  readonly saved: number;
  readonly queued: number;
}

/**
 * Turn argv into a fully parsed plan. A catalog argument is parsed here so that
 * `main` reaches no token, browser, or output directory on corrupt catalog data.
 */
export function resolveCrawlKbPlan(argv: readonly string[]): CrawlKbPlan {
  const arg = argv[0];
  if (arg !== undefined && arg.endsWith('.json') && existsSync(arg)) {
    return { kind: 'catalog', links: parseBoundaryCrawlCatalogV1(readFileSync(arg, 'utf8')) };
  }
  return { kind: 'seed', seedUrl: arg ?? SEED_FALLBACK_URL };
}

/**
 * The pages to visit, plus the link count the summary reports. A seed run also
 * visits the seed page itself, which is not one of the links it discovered.
 */
async function resolveCrawlQueue(
  page: Page,
  plan: CrawlKbPlan
): Promise<{ readonly queue: readonly CrawlKbLink[]; readonly discovered: number }> {
  switch (plan.kind) {
    case 'catalog':
      return { queue: plan.links, discovered: plan.links.length };
    case 'seed': {
      await page.goto(plan.seedUrl, { waitUntil: 'networkidle', timeout: 90_000 }).catch(() => {});
      const links: CrawlKbLink[] = await page.evaluate(() => {
        const anchors = [...document.querySelectorAll('a[href*="detailPage"]')] as HTMLAnchorElement[];
        return [...new Map(anchors.map(a => [a.href, (a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120)])).entries()]
          .map(([href, text]) => ({ href, text }));
      });
      return { queue: [{ href: plan.seedUrl, text: 'Seed page' }, ...links], discovered: links.length };
    }
    default: {
      const unreachable: never = plan;
      throw new Error(`unsupported crawl plan: ${JSON.stringify(unreachable)}`);
    }
  }
}

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60);
}

function articleIdFromUrl(url: string): string {
  const m = url.match(/articleId%22%3A%22([^%]+)/) || url.match(/articleId":"([^"]+)/);
  return m?.[1] ?? slug(url);
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  session: KbScriptSession = liveKbScriptSession
): Promise<CrawlKbSummary> {
  const plan = resolveCrawlKbPlan(argv);

  const tokens = await session.resolveTokens();
  if (!tokens.libraryToken && !tokens.tokenByCode) {
    console.error('Run pnpm run login:one:safari first');
    process.exit(1);
  }

  const maxPages = Number(process.env.SANGFOR_BROWSER_CRAWL_MAX ?? 120);
  const rawDir = join(kbDataDir(), 'raw');
  mkdirSync(rawDir, { recursive: true });

  return withKbBrowser(tokens, async ({ page }) => {
    const ready = await session.prepare(tokens, page);
    if (!ready) console.error('Warning: KB may still show Login — crawl quality may be low.');

    const { queue, discovered } = await resolveCrawlQueue(page, plan);
    const visited = new Set<string>();
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

    return { saved, queued: discovered };
  }, session.launch);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    (summary) => { console.log(JSON.stringify(summary, null, 2)); },
    (err: unknown) => { console.error(err); process.exit(1); }
  );
}
