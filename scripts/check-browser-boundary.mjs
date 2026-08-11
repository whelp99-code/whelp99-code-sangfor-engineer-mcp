import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const targets = [
  'packages/sangfor-operator',
  'packages/sangfor-verifier',
  'packages/sangfor-screenshot',
  'packages/sangfor-observer',
  'packages/sangfor-evidence',
  'packages/sangfor-product-adapters',
  'apps/mcp-server/src',
];
const forbidden = [
  ['playwright import', /(?:from\s+|import\()['"]playwright['"]/],
  ['browser launcher', /\b(?:chromium|firefox|webkit)\.(?:launch|connect|connectOverCDP)\s*\(/],
  ['chrome package import', /(?:@sangfor\/chrome|sangfor-chrome\/src)/],
  ['CDP connection', /\bconnectOverCDP\b/],
  ['Chrome lifecycle', /\b(?:ensureChromeRunning|stopChrome)\b/],
  ['direct page navigation', /\b(?:page|browserPage)\.(?:goto|goBack|goForward|reload)\s*\(/],
  ['direct page mutation', /\b(?:page|browserPage)\.(?:click|fill|type|press|selectOption|dispatchEvent)\s*\(/],
  ['direct page evidence', /\b(?:page|browserPage)\.(?:screenshot|pdf|content|evaluate|evaluateHandle)\s*\(/],
  ['direct page locator', /\b(?:page|browserPage)\.(?:locator|getByRole|getByText|getByLabel|getByPlaceholder)\s*\(/],
  ['browser DOM global', /\b(?:document\.(?:querySelector|querySelectorAll)|window\.getComputedStyle)\b/],
  ['observer CDP implementation', /\bHttpCdpObserverTransport\b/],
  ['raw CDP websocket', /\bnew WebSocket\b/],
  ['raw CDP protocol', /\/json\/(?:list|version)|Runtime\.evaluate|DOMStorage\.enable/],
];

function filesUnder(path) {
  const absolute = join(root, path);
  if (statSync(absolute).isFile()) return [absolute];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const child = join(absolute, entry.name);
    if (entry.isDirectory()) return filesUnder(relative(root, child));
    return /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name) ? [child] : [];
  });
}

const violations = [];
for (const absolute of targets.flatMap(filesUnder)) {
  const path = relative(root, absolute);
  const source = readFileSync(absolute, 'utf8');
  for (const [label, pattern] of forbidden) {
    if (pattern.test(source)) violations.push(`${path}: ${label}`);
  }
}

if (violations.length > 0) {
  process.stderr.write(`${violations.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('BLRO_READY_BROWSER_BOUNDARY_PASS\n');
}
