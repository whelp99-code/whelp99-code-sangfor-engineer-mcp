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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { loadEnvFile } from '../packages/sangfor-collector/src/load-env.js';
import { withKbBrowser } from './lib/kb-browser-session.js';
import { crawlAndRenderPageBodies } from './lib/kb-full-site-crawl.js';
import {
  dedupeEntries,
  discoverSiteMap,
  type KbPageEntry
} from './lib/kb-full-site-discovery.js';
import {
  ingestCrawledPages,
  renderProductTablesMd
} from './lib/kb-full-site-persistence.js';
import { parseBoundaryKbSiteMapV1 } from './lib/kb-runtime-boundaries.js';
import { kbDataDir, liveKbScriptSession, type KbScriptSession } from './lib/kb-script-runtime.js';
import { loadProductTableSeeds } from './lib/parse-product-tables.js';

export type { KbPageEntry } from './lib/kb-full-site-discovery.js';

loadEnvFile('.env');

type CrawlPersistenceOptions = {
  readonly page: Page;
  readonly entries: KbPageEntry[];
  readonly rawDir: string;
  readonly maxPages: number;
};

function writeProductTablesMd(entries: KbPageEntry[], path: string): void {
  writeFileSync(path, renderProductTablesMd(entries), 'utf8');
}

async function crawlPageBodies(options: CrawlPersistenceOptions): Promise<number> {
  return crawlAndRenderPageBodies({
    page: options.page,
    entries: options.entries,
    maxPages: options.maxPages,
    saveBody: (id, markdown) => writeFileSync(join(options.rawDir, `kb_site_${id}.md`), markdown, 'utf8')
  });
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  session: KbScriptSession = liveKbScriptSession
): Promise<void> {
  const maxPages = Number(process.env.SANGFOR_KB_FULL_MAX ?? 0) || Infinity;
  const skipDiscover = argv.includes('--crawl-only');
  const discoverOnly = argv.includes('--discover-only');
  const dataDir = kbDataDir();
  const rawDir = join(dataDir, 'raw');
  const mapPath = join(dataDir, 'kb-site-map.json');
  const tablesPath = join(dataDir, 'sangfor_product_tables.md');

  // Parsed before any token, directory, or browser is spent, so a corrupt map
  // leaves no raw-data directory and no running browser behind.
  const persistedEntries = skipDiscover && existsSync(mapPath)
    ? parseBoundaryKbSiteMapV1(readFileSync(mapPath, 'utf8'))
    : undefined;

  const tokens = await session.resolveTokens();
  if (!tokens.libraryToken && !tokens.tokenByCode) {
    console.error('Missing KB token. Run: pnpm run login:one:safari (or open KB in Glass + SANGFOR_CDP_URL)');
    process.exit(1);
  }

  mkdirSync(rawDir, { recursive: true });

  const seedPaths = [
    tablesPath,
    join(process.env.HOME ?? '', 'Downloads/sangfor_product_tables.md')
  ].filter(path => existsSync(path));
  const seeds = loadProductTableSeeds(seedPaths);
  console.error(`Seed URLs from product tables: ${seeds.length}`);

  const { entries, saved } = await withKbBrowser(tokens, async ({ page }) => {
    let sessionEntries: KbPageEntry[] = [];

    if (persistedEntries !== undefined) {
      sessionEntries = persistedEntries;
    } else {
      const ready = await session.prepare(tokens, page);
      if (!ready) {
        console.error(
          'KB session not ready in Playwright (still on Login). Try: SANGFOR_KB_HEADED=1 pnpm run learn:kb:full, or log in via Glass and set SANGFOR_CDP_URL.'
        );
        if (seeds.length) {
          console.error(`Falling back to ${seeds.length} seeded URLs only.`);
          sessionEntries = dedupeEntries(seeds);
        } else {
          throw new Error('KB session is not ready and no seeded URLs are available.');
        }
      } else {
        sessionEntries = await discoverSiteMap(page, seeds);
      }

      if (sessionEntries.length === 0 && seeds.length) {
        sessionEntries = dedupeEntries(seeds);
      }

      writeFileSync(mapPath, JSON.stringify(sessionEntries, null, 2), 'utf8');
      if (sessionEntries.length > 0) {
        writeProductTablesMd(sessionEntries, tablesPath);
        writeFileSync(
          join(dataDir, 'product-tables-urls.json'),
          JSON.stringify(sessionEntries.map(entry => ({
            href: entry.url,
            text: entry.title,
            product: entry.product
          })), null, 2),
          'utf8'
        );
      }
    }

    console.error(`Site map: ${sessionEntries.length} unique articles`);

    if (discoverOnly) {
      return { entries: sessionEntries, saved: 0 };
    }

    if (sessionEntries.length === 0) {
      throw new Error('No articles to crawl.');
    }

    const crawled = await crawlPageBodies({ page, entries: sessionEntries, rawDir, maxPages });
    return { entries: sessionEntries, saved: crawled };
  }, session.launch);

  if (discoverOnly) {
    console.log(JSON.stringify({
      siteMapArticles: entries.length,
      siteMapFile: mapPath,
      tablesFile: tablesPath
    }, null, 2));
    return;
  }

  if (entries.length > 0 && !existsSync(mapPath)) {
    writeFileSync(mapPath, JSON.stringify(entries, null, 2), 'utf8');
    writeProductTablesMd(entries, tablesPath);
    writeFileSync(
      join(dataDir, 'product-tables-urls.json'),
      JSON.stringify(entries.map(entry => ({
        href: entry.url,
        text: entry.title,
        product: entry.product
      })), null, 2),
      'utf8'
    );
  }

  const ingestion = await ingestCrawledPages(rawDir);
  console.log(JSON.stringify({
    siteMapArticles: entries.length,
    seedUrls: seeds.length,
    pagesCrawled: saved,
    tablesFile: tablesPath,
    siteMapFile: mapPath,
    filesIngested: ingestion.filesIngested,
    chunks: ingestion.chunks,
    rag: ingestion.rag
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
