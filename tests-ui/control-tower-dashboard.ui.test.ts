import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, type Browser, type Page } from 'playwright';
import { createTowerServer } from '../apps/control-tower/src/server.js';

// The served client <script> once broke because a template escape rendered \' as
// ' and the whole <script> failed to parse — invisible to HTML-string assertions.
// This suite loads the page in real chromium to catch that class of defect. It
// lives in tests-ui/ (own config, `npm run test:ui`) so the unit suite stays
// browser-free; a lightweight parse-guard remains in the main suite.

const TOOLS = {
  tools: [
    { name: 'sangfor.advisor_read', description: 'read-only advisory', inputSchema: { type: 'object', properties: { host: { type: 'string' } } }, annotations: { title: 'read', readOnlyHint: true, destructiveHint: false }, category: 'advisory' },
    { name: 'sangfor.apply_write', description: 'write op', inputSchema: { type: 'object', properties: { customer: { type: 'string' } }, required: ['customer'] }, annotations: { title: 'write', readOnlyHint: false, destructiveHint: false }, category: 'pm' },
  ],
};

let bridge: http.Server, bridgeUrl: string, runsDir: string, registryDir: string, outDir: string;
let tower: http.Server, towerUrl: string, browser: Browser;

function startBridge(): Promise<void> {
  bridge = http.createServer(async (req, res) => {
    const send = (s: number, b: unknown) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (req.method === 'GET' && req.url === '/health') return send(200, { status: 'ok', mcp: 'connected' });
    if (req.method === 'GET' && req.url === '/tools') return send(200, TOOLS);
    if (req.method === 'POST' && req.url === '/tools/call') {
      const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { name?: string };
      // Any tool resolves benignly so the health widget never hits fail()→alert().
      const payload = body.name === 'sangfor.advisor_read'
        ? { evaluation: { specId: 's', ok: true, items: [], summary: { pass: 1, fail: 0 }, coverage: {} } }
        : { ok: true };
      return send(200, { result: { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload, isError: false } });
    }
    send(404, { error: 'nf' });
  });
  return new Promise((r) => bridge.listen(0, '127.0.0.1', () => { bridgeUrl = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`; r(); }));
}

const urlOf = (s: http.Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;

function startTower(): Promise<http.Server> {
  const s = createTowerServer({ bridgeUrl, runsDir, registryDir, playbookOutputDir: outDir, approvalSecret: 'sec', apiToken: 'test-token', mockConsoleUrl: 'http://127.0.0.1:1' });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s)));
}

const PANELS = ['dashboard', 'tools', 'runs', 'devices', 'playbooks'] as const;

async function isActive(page: Page, panelId: string): Promise<boolean> {
  return page.locator('#' + panelId).evaluate((el) => el.classList.contains('active'));
}

interface Instrumented { page: Page; pageErrors: string[]; dialogs: string[] }

async function openDashboard(): Promise<Instrumented> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors: string[] = [];
  const dialogs: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  page.on('dialog', (d) => { dialogs.push(d.message()); void d.dismiss(); });
  await page.addInitScript((t) => localStorage.setItem('sangfor_api_token', t), 'test-token');
  await page.goto(towerUrl, { waitUntil: 'networkidle' });
  return { page, pageErrors, dialogs };
}

beforeAll(async () => {
  runsDir = mkdtempSync(join(tmpdir(), 'ui-runs-'));
  registryDir = mkdtempSync(join(tmpdir(), 'ui-reg-'));
  outDir = mkdtempSync(join(tmpdir(), 'ui-out-'));
  await startBridge();
  tower = await startTower();
  towerUrl = urlOf(tower);
  browser = await chromium.launch({ headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((r) => tower.close(() => r()));
  await new Promise<void>((r) => bridge.close(() => r()));
  for (const d of [runsDir, registryDir, outDir]) rmSync(d, { recursive: true, force: true });
});

describe('Control Tower dashboard — real browser regression (P0-1)', () => {
  it('serves a <script> that executes: dashboard boots with zero pageerror', async () => {
    const { page, pageErrors } = await openDashboard();
    // A parse failure leaves the IIFE unexecuted and window.loadOverview undefined.
    const booted = await page.evaluate(() => typeof (window as unknown as { loadOverview?: unknown }).loadOverview === 'function');
    expect(booted, 'client script did not execute (window.loadOverview missing)').toBe(true);
    expect(pageErrors, `unexpected page errors: ${pageErrors.join(' | ')}`).toEqual([]);
    await page.context().close();
  });

  it('renders all five panels and switches tabs on click', async () => {
    const { page, pageErrors, dialogs } = await openDashboard();
    expect(await isActive(page, 'dashboard')).toBe(true);

    for (const target of PANELS) {
      await page.locator('#nav button[data-panel="' + target + '"]').click();
      await page.waitForFunction(
        (id) => document.getElementById(id)?.classList.contains('active') === true,
        target,
        { timeout: 5_000 },
      );
      expect(await isActive(page, target), `panel ${target} not active after click`).toBe(true);
      for (const other of PANELS) {
        if (other !== target) expect(await isActive(page, other), `panel ${other} should be inactive`).toBe(false);
      }
    }

    expect(dialogs, `unexpected error dialogs: ${dialogs.join(' | ')}`).toEqual([]);
    expect(pageErrors, `unexpected page errors: ${pageErrors.join(' | ')}`).toEqual([]);
    await page.context().close();
  });

  it('renders panel content (labels + a data-driven table) after navigation', async () => {
    const { page } = await openDashboard();
    await page.locator('#nav button[data-panel="playbooks"]').click();
    await page.waitForFunction(() => (document.getElementById('playbooks')?.textContent ?? '').includes('AI 조립 요청'), undefined, { timeout: 5_000 });
    expect((await page.locator('#playbooks').textContent()) ?? '').toContain('AI 조립 요청');
    await page.locator('#nav button[data-panel="tools"]').click();
    await page.waitForFunction(() => (document.getElementById('tool-tabs')?.children.length ?? 0) > 0, undefined, { timeout: 5_000 });
    expect((await page.locator('#tool-tabs').textContent()) ?? '').toContain('advisory');
    await page.context().close();
  });
});
