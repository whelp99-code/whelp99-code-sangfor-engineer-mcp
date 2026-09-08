import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Browser, Page } from 'playwright';
import { chromium } from 'playwright';
import { createOperatorServer } from '../apps/operator-console/src/server.js';

let browser: Browser;
let server: ReturnType<typeof createOperatorServer>;
let baseUrl: string;

const malicious = '<img src=x onerror="window.__untrustedExecuted=true">';

async function openConsole(): Promise<{ page: Page; postedBodies: unknown[] }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const postedBodies: unknown[] = [];
  await page.addInitScript(() => { (window as unknown as { __untrustedExecuted?: boolean }).__untrustedExecuted = false; });
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/rag-search') {
      postedBodies.push(route.request().postDataJSON());
      return route.fulfill({ json: {
        results: [
          { id: 'semantic', title: `Semantic ${malicious}`, product: 'HCI', version: '6.11', section: 'Network', trustLevel: 'official', text: malicious, source: `data/${malicious}`, retrievalMode: 'hybrid-semantic' },
          { id: 'hash', title: 'Hash result', product: 'HCI', version: '6.11', section: 'Storage', trustLevel: 'internal', text: 'hash text', source: 'data/hash.md', retrievalMode: 'hybrid-hash' },
          { id: 'bm25', title: 'BM25 result', product: 'IAG', version: '13.0', section: 'Policy', trustLevel: 'draft', text: 'bm25 text', source: 'data/bm25.md', retrievalMode: 'bm25' },
          { id: 'unknown', title: 'Unknown result', product: 'unknown', version: undefined, section: undefined, trustLevel: undefined, text: 'unknown text', source: undefined, retrievalMode: 'unverified-mode' },
        ],
        diagnostics: { searchMode: 'hash', degraded: false },
      } });
    }
    if (url.pathname === '/api/knowledge') {
      return route.fulfill({ json: { items: [{ title: `Knowledge ${malicious}`, product: 'HCI', sourceType: 'manual', text: malicious }] } });
    }
    if (url.pathname === '/api/summary') return route.fulfill({ json: { manualCount: 0, wikiCount: 0, rag: { chunkCount: 0 }, storeEnabled: false } });
    if (url.pathname === '/api/health/store') return route.fulfill({ json: { enabled: false, ok: false } });
    if (url.pathname === '/api/health/embeddings') return route.fulfill({ json: { embeddingHealth: { ok: false }, mimoRerankHealth: { ok: false }, dimensions: 0, allowCloudRag: false } });
    return route.fulfill({ json: {} });
  });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  return { page, postedBodies };
}

beforeAll(async () => {
  server = createOperatorServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

describe('operator console RAG search — real browser', () => {
  it('forwards the version and safely renders searchable metadata with honest modes', async () => {
    const { page, postedBodies } = await openConsole();
    await page.locator('#nav button[data-panel="rag"]').click();
    await page.locator('#rag-query').fill('HA settings');
    await page.locator('#rag-version').fill('6.11');
    await page.locator('#btn-rag').click();
    await page.waitForFunction(() => document.querySelectorAll('#rag-hits article').length === 4);

    expect(postedBodies).toEqual([expect.objectContaining({ query: 'HA settings', version: '6.11' })]);
    const text = await page.locator('#rag-hits').textContent();
    expect(text).toContain('제품: HCI · 버전: 6.11 · 섹션: Network · 신뢰: official');
    expect(await page.locator('#rag-hits h3').first().textContent()).toBe(`Semantic ${malicious}`);
    expect(text).toContain(`출처: data/${malicious}`);
    expect(text).toContain('검색 모드: semantic');
    expect(text).toContain('검색 모드: hash');
    expect(text).toContain('검색 모드: bm25');
    expect(text).toContain('검색 모드: unknown');
    expect(await page.evaluate(() => (window as unknown as { __untrustedExecuted?: boolean }).__untrustedExecuted)).toBe(false);
    expect(await page.locator('#rag-hits img').count()).toBe(0);
    expect(await page.locator('#rag-hits a').count()).toBe(0);
    await page.context().close();
  });

  it('renders untrusted knowledge and API errors as inert text, and makes empty results actionable', async () => {
    const { page } = await openConsole();
    await page.locator('#nav button[data-panel="knowledge"]').click();
    await page.locator('#btn-knowledge').click();
    await page.waitForFunction(() => (document.querySelector('#kn-content')?.textContent ?? '').includes('Knowledge'));
    expect(await page.locator('#kn-content img').count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __untrustedExecuted?: boolean }).__untrustedExecuted)).toBe(false);

    await page.route('**/api/rag-search', (route) => route.fulfill({ status: 500, json: { error: malicious } }));
    await page.locator('#nav button[data-panel="rag"]').click();
    await page.locator('#btn-rag').click();
    await page.waitForFunction(() => (document.querySelector('#rag-hits')?.textContent ?? '').includes('오류:'));
    expect(await page.locator('#rag-hits').textContent()).toContain(malicious);
    expect(await page.locator('#rag-hits img').count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __untrustedExecuted?: boolean }).__untrustedExecuted)).toBe(false);

    await page.route('**/api/rag-search', (route) => route.fulfill({ json: { results: [], diagnostics: { searchMode: 'unknown', degraded: true } } }));
    await page.locator('#btn-rag').click();
    await page.waitForFunction(() => (document.querySelector('#rag-hits')?.textContent ?? '').includes('제품 또는 버전을 바꿔'));
    await page.context().close();
  });
});
