import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { PRODUCTS } from '../packages/shared/src/index.js';
import * as ui from '../apps/operator-console/src/ui.js';
import * as uiAuth from '../apps/operator-console/src/ui-auth.js';
import { DASHBOARD_STYLE_BLOCK } from '../apps/operator-console/src/ui-styles.js';
import { DASHBOARD_BODY } from '../apps/operator-console/src/ui-layout.js';
import { CLIENT_CORE_SCRIPT } from '../apps/operator-console/src/ui-client-core.js';
import { CLIENT_ACTION_SCRIPT } from '../apps/operator-console/src/ui-client-actions.js';
import { createOperatorServer } from '../apps/operator-console/src/server.js';

const SRC_DIR = fileURLToPath(new URL('../apps/operator-console/src/', import.meta.url));
const PURE_LOC_CEILING = 250;

/** Every document fragment has exactly one owning module; ui.ts only assembles them. */
const FRAGMENT_OWNERSHIP: Readonly<Record<string, string>> = {
  'ui-styles.ts': DASHBOARD_STYLE_BLOCK,
  'ui-layout.ts': DASHBOARD_BODY,
  'ui-client-core.ts': CLIENT_CORE_SCRIPT,
  'ui-client-actions.ts': CLIENT_ACTION_SCRIPT
};

const sourceFiles = readdirSync(SRC_DIR).filter((name) => name.endsWith('.ts')).sort();
const readSource = (name: string): string => readFileSync(SRC_DIR + name, 'utf8');

/** Mirrors the reviewer's ceiling metric: non-blank, non-comment lines. */
function pureLoc(source: string): number {
  return source.split('\n').filter((line) => {
    const trimmed = line.trim();
    return trimmed !== '' && !trimmed.startsWith('//');
  }).length;
}

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/(?:from|import)\s+'([^']+)'/g)].map((m) => m[1]);
}

/** Lifts a named function declaration out of the rendered client script by brace balance. */
function extractClientFunction(script: string, name: string): string {
  const start = script.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`client script does not declare function ${name}`);
  let depth = 0;
  for (let i = script.indexOf('{', start); i < script.length; i++) {
    if (script[i] === '{') depth++;
    if (script[i] === '}') depth--;
    if (depth === 0) return script.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces while extracting ${name}`);
}

const html = ui.dashboardHtml();
const clientScript = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
const markupIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const queriedIds = new Set([
  ...[...clientScript.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]),
  ...[...clientScript.matchAll(/lines\('([^']+)'\)/g)].map((m) => m[1])
]);
const navTargets = [...html.matchAll(/data-panel="([^"]+)"/g)].map((m) => m[1]);
const serverRoutes = new Set(
  [...readSource('server.ts').matchAll(/url\.pathname === '([^']+)'/g)].map((m) => m[1])
);
const scriptRoutes = new Set(
  [...clientScript.matchAll(/'(\/api\/[^']*)'/g)].map((m) => m[1].split('?')[0])
);

describe('operator console UI modules', () => {
  it('keeps every module under the pure-LOC ceiling', () => {
    // Given: the shipped source tree of the app.
    // When: each file is measured in pure (non-blank, non-comment) lines.
    const oversized = sourceFiles
      .map((name) => ({ name, loc: pureLoc(readSource(name)) }))
      .filter((entry) => entry.loc > PURE_LOC_CEILING);
    // Then: no file has outgrown a single reviewer's working memory.
    expect(sourceFiles.length).toBeGreaterThan(0);
    expect(oversized, `modules over ${PURE_LOC_CEILING} pure LOC`).toEqual([]);
  });

  it('exposes exactly the three public names the app and tests consume', () => {
    // Then: the facade surface is unchanged by the split.
    expect(Object.keys(ui).sort()).toEqual(['API_TOKEN_STORAGE_KEY', 'buildApiHeaders', 'dashboardHtml']);
    expect(typeof ui.dashboardHtml).toBe('function');
    expect(ui.API_TOKEN_STORAGE_KEY).toBe('sangfor_api_token');
  });

  it('re-exports the header builder by identity so the facade cannot drift from the module', () => {
    // Then: it is one function, not two implementations free to diverge.
    expect(ui.buildApiHeaders).toBe(uiAuth.buildApiHeaders);
    expect(ui.API_TOKEN_STORAGE_KEY).toBe(uiAuth.API_TOKEN_STORAGE_KEY);
  });

  it('assembles the document from the owning modules instead of a local copy', () => {
    // Given: the fragment each module owns.
    // When: the document is rendered.
    // Then: every fragment appears verbatim, exactly once.
    for (const [name, fragment] of Object.entries(FRAGMENT_OWNERSHIP)) {
      expect(fragment.length, `${name} owns an empty fragment`).toBeGreaterThan(100);
      expect(html.split(fragment), `${name} fragment is not rendered exactly once`).toHaveLength(2);
    }
  });

  it('reaches the UI layer only through the ui.ts facade', () => {
    const uiImportsInServer = importSpecifiers(readSource('server.ts')).filter((spec) => spec.includes('/ui') || spec.startsWith('./ui'));
    expect(uiImportsInServer).toEqual(['./ui.js']);
  });

  it('keeps UI modules independent of the server and API layers', () => {
    const leaks = sourceFiles
      .filter((name) => name.startsWith('ui'))
      .map((name) => ({ name, imports: importSpecifiers(readSource(name)).filter((spec) => /\.\/(server|api|case-resolution)\.js$/.test(spec)) }))
      .filter((entry) => entry.imports.length > 0);
    expect(leaks, 'UI modules must not import the transport or handler layer').toEqual([]);
  });
});

describe('dashboardHtml document', () => {
  it('renders one doctype-first document with a single style and script block', () => {
    expect(html.startsWith('<!doctype html>\n<html lang="ko">')).toBe(true);
    expect(html.match(/<style>/g)).toHaveLength(1);
    expect(html.match(/<\/style>/g)).toHaveLength(1);
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
  });

  it('renders a panel div for every nav target', () => {
    expect(navTargets).toEqual(['dashboard', 'analyze', 'plan', 'rag', 'products', 'feedback', 'knowledge', 'automation']);
    const missing = navTargets.filter((target) => !new RegExp(`<div id="${target}" class="panel`).test(html));
    expect(missing, 'nav buttons without a matching panel div').toEqual([]);
  });

  it('renders a markup element for every id the client script queries', () => {
    expect(queriedIds.size).toBeGreaterThan(40);
    const missing = [...queriedIds].filter((id) => !markupIds.has(id));
    expect(missing, 'ids queried by the client script but absent from the markup').toEqual([]);
  });

  it('offers every known product in each product select', () => {
    const productSelects = [...html.matchAll(/<select id="([a-z]+-product)">([\s\S]*?)<\/select>/g)];
    expect(productSelects.length).toBeGreaterThanOrEqual(6);
    for (const [, id, options] of productSelects) {
      for (const product of PRODUCTS) {
        expect(options, `select ${id} is missing product ${product.code}`).toContain(`<option value="${product.code}">`);
      }
    }
  });

  it('calls only API routes the operator server serves', () => {
    const unserved = [...scriptRoutes].filter((route) => !serverRoutes.has(route));
    expect(unserved, 'client script calls routes the server does not route').toEqual([]);
    expect(scriptRoutes.has('/api/summary')).toBe(true);
    expect(scriptRoutes.has('/api/rag-search')).toBe(true);
  });

  it('hands the client the same token storage key the module exports', () => {
    expect(clientScript).toContain(`const API_TOKEN_STORAGE_KEY = '${ui.API_TOKEN_STORAGE_KEY}';`);
  });

  it('boots the client by initializing the token input and loading the dashboard', () => {
    expect(clientScript).toMatch(/function initTokenInput\(\)/);
    expect(clientScript).toMatch(/async function loadDashboard\(\)/);
    expect(clientScript.trimEnd().endsWith('initTokenInput();\n    loadDashboard();')).toBe(true);
  });

  it('serves a client script that parses as JavaScript', () => {
    // A mangled template escape renders as a syntax error the whole <script> dies on,
    // which no substring assertion can see. Parse it (without executing) instead.
    expect(() => new Function(clientScript)).not.toThrow();
  });

  it('builds client auth headers identically to the exported builder', () => {
    const factory = new Function(`${extractClientFunction(clientScript, 'buildApiHeaders')} return buildApiHeaders;`) as () => typeof ui.buildApiHeaders;
    const clientBuild = factory();
    // Then: the browser copy trims, prefixes and preserves caller headers exactly as the export does.
    expect(clientBuild('secret-token', { 'content-type': 'application/json' })).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer secret-token'
    });
    expect(clientBuild('  padded  ', {})).toEqual({ authorization: 'Bearer padded' });
    expect(clientBuild('', { 'x-a': 'b' })).toEqual({ 'x-a': 'b' });
    for (const token of ['secret-token', '  padded  ', '']) {
      expect(clientBuild(token, { 'x-a': 'b' })).toEqual(ui.buildApiHeaders(token, { 'x-a': 'b' }));
    }
  });
});

describe('GET / on the operator console', () => {
  it('serves the assembled dashboard document as UTF-8 html', async () => {
    const server = createOperatorServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(await res.text()).toBe(html);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
