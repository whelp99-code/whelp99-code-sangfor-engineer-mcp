/**
 * The KB crawl scripts take their work list from persisted JSON. A corrupt list
 * must be rejected before the script spends anything: no token resolution, no
 * browser, no output directory. These tests drive the scripts' real entry points
 * with the browser ports faked, and assert on which effects the input reached.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import { RuntimeSchemaError } from '../packages/shared/src/runtime-schema.js';
import { main as runCrawlKbWithStorage } from '../scripts/crawl-kb-with-storage.js';
import { main as runLearnKbFullSite } from '../scripts/learn-kb-full-site.js';
import type { KbBrowserHandle, KbBrowserTokens } from '../scripts/lib/kb-browser-session.js';
import type { KbScriptSession } from '../scripts/lib/kb-script-runtime.js';

const TOKENS: KbBrowserTokens = { libraryToken: 'library-token', tokenByCode: 'token-by-code' };

const VALID_CATALOG = [{ href: 'https://knowledgebase.invalid/detailPage?articleId=a1', text: 'Article one' }];
const VALID_SITE_MAP = [{
  section: 'HCI', title: 'Article one', type: 'Document', updated: '2026-08-27',
  url: 'https://knowledgebase.invalid/detailPage?articleId=a1', product: 'HCI', articleId: 'article-1'
}];

/** Rejected by the strict codecs: an unexpected key the `.strict()` schema refuses. */
const CORRUPT_CATALOG = [{ ...VALID_CATALOG[0], token: 'smuggled-secret' }];
const CORRUPT_SITE_MAP = [{ ...VALID_SITE_MAP[0], token: 'smuggled-secret' }];

// `/tmp` on this host enforces a user quota that these writes exceed, and
// `data/runtime/` is already git-ignored, so scratch roots live there. Each root
// is uniquely named so concurrent runs of this suite cannot collide.
const SCRATCH_PARENT = join(import.meta.dirname, '..', 'data', 'runtime');
const scratchRoots: string[] = [];

function scratchRoot(): string {
  mkdirSync(SCRATCH_PARENT, { recursive: true });
  const root = mkdtempSync(join(SCRATCH_PARENT, 'kb-script-boundary-'));
  scratchRoots.push(root);
  return root;
}

/** A data root the scripts will treat as their artifact directory, holding `file`. */
function dataRootHolding(file: string, contents: unknown): string {
  const root = scratchRoot();
  writeFileSync(join(root, file), JSON.stringify(contents), 'utf8');
  vi.stubEnv('SANGFOR_KB_DATA_DIR', root);
  vi.stubEnv('HOME', root);
  return root;
}

/**
 * A Page that fails loudly on navigation. Every test here either never touches
 * the page, or exercises a path whose contract is to survive a page failure.
 */
function fakeKbPage(): Page {
  const page: Pick<Page, 'goto'> = {
    goto: async () => { throw new Error('fake page: navigation is unavailable in tests'); }
  };
  return page as Page;
}

function sessionProbe(prepare: () => Promise<boolean> = async () => true) {
  const close = vi.fn(async () => {});
  const launch = vi.fn(async () => ({
    browser: {} as KbBrowserHandle['browser'],
    context: {} as KbBrowserHandle['context'],
    page: fakeKbPage(),
    close
  }));
  const resolveTokens = vi.fn(async () => TOKENS);
  const prepareSpy = vi.fn(prepare);
  const session: KbScriptSession = { resolveTokens, launch, prepare: prepareSpy };
  return { session, resolveTokens, launch, prepare: prepareSpy, close };
}

async function rejectionOf(pending: Promise<unknown>): Promise<unknown> {
  try {
    await pending;
  } catch (error) {
    return error;
  }
  throw new Error('expected the script to reject, but it resolved');
}

function expectRuntimeSchemaError(error: unknown, schemaName: string): void {
  expect(error).toBeInstanceOf(RuntimeSchemaError);
  if (!(error instanceof RuntimeSchemaError)) throw error;
  expect(error.schemaName).toBe(schemaName);
}

function messageOf(error: unknown): string {
  if (!(error instanceof Error)) throw new Error(`expected an Error, got ${String(error)}`);
  return error.message;
}

afterEach(() => {
  for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('crawl-kb-with-storage catalog boundary', () => {
  it('reaches no token, browser, or output directory when the catalog is corrupt', async () => {
    // Given a catalog file the strict crawl-catalog codec refuses
    const root = dataRootHolding('catalog.json', CORRUPT_CATALOG);
    const probe = sessionProbe();

    // When the script runs against it
    const error = await rejectionOf(runCrawlKbWithStorage([join(root, 'catalog.json')], probe.session));

    // Then the corrupt input is refused before any effect is spent
    expectRuntimeSchemaError(error, 'learning-operations.crawl-catalog.v1');
    expect(probe.resolveTokens).not.toHaveBeenCalled();
    expect(probe.launch).not.toHaveBeenCalled();
    expect(probe.prepare).not.toHaveBeenCalled();
    expect(existsSync(join(root, 'raw'))).toBe(false);
  });

  it('launches the browser and queues every catalog link when the catalog is valid', async () => {
    // Given a catalog the strict codec accepts
    const root = dataRootHolding('catalog.json', VALID_CATALOG);
    const probe = sessionProbe();

    // When the script runs against it
    const summary = await runCrawlKbWithStorage([join(root, 'catalog.json')], probe.session);

    // Then the browser did the work and the catalog's links were the queue
    expect(probe.launch).toHaveBeenCalledOnce();
    expect(summary.queued).toBe(VALID_CATALOG.length);
  });

  it('closes the browser and surfaces the error when preparation fails', async () => {
    // Given a valid catalog but a KB session that cannot be prepared
    const root = dataRootHolding('catalog.json', VALID_CATALOG);
    const probe = sessionProbe(async () => { throw new Error('kb session unavailable'); });

    // When the script runs
    const error = await rejectionOf(runCrawlKbWithStorage([join(root, 'catalog.json')], probe.session));

    // Then the failure propagates unchanged and the browser is still released
    expect(messageOf(error)).toBe('kb session unavailable');
    expect(probe.close).toHaveBeenCalledOnce();
  });
});

describe('learn-kb-full-site persisted site map boundary', () => {
  it('creates no raw-data directory and opens no browser when the persisted map is corrupt', async () => {
    // Given a persisted site map the strict kb-site-map codec refuses
    const root = dataRootHolding('kb-site-map.json', CORRUPT_SITE_MAP);
    const probe = sessionProbe();

    // When the crawl-only run reuses that map
    const error = await rejectionOf(runLearnKbFullSite(['--crawl-only'], probe.session));

    // Then nothing was created and no browser was opened
    expectRuntimeSchemaError(error, 'learning-operations.kb-site-map.v1');
    expect(existsSync(join(root, 'raw'))).toBe(false);
    expect(probe.resolveTokens).not.toHaveBeenCalled();
    expect(probe.launch).not.toHaveBeenCalled();
  });

  it('creates the raw-data directory and opens a browser when the persisted map is valid', async () => {
    // Given a persisted site map the strict codec accepts
    const root = dataRootHolding('kb-site-map.json', VALID_SITE_MAP);
    const probe = sessionProbe();

    // When the discovery-reporting run reuses that map
    await runLearnKbFullSite(['--crawl-only', '--discover-only'], probe.session);

    // Then the real run still provisions its output directory and browser
    expect(existsSync(join(root, 'raw'))).toBe(true);
    expect(probe.launch).toHaveBeenCalledOnce();
    expect(probe.close).toHaveBeenCalledOnce();
  });

  it('closes the browser when the accepted map yields nothing to crawl', async () => {
    // Given a structurally valid but empty persisted map
    dataRootHolding('kb-site-map.json', []);
    const probe = sessionProbe();

    // When the crawl-only run reuses it
    const error = await rejectionOf(runLearnKbFullSite(['--crawl-only'], probe.session));

    // Then the existing refusal stands and the browser is released
    expect(messageOf(error)).toBe('No articles to crawl.');
    expect(probe.close).toHaveBeenCalledOnce();
  });
});
