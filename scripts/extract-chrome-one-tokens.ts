import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { loadEnvFile } from '../packages/sangfor-collector/src/load-env.js';
import {
  loadOneSessionFromEnv,
  resolveAuthTokens,
  verifyOneSession
} from '../packages/sangfor-collector/src/index.js';

function defaultChromeLevelDbDir(): string {
  const home = process.env.HOME ?? '';
  if (process.platform === 'darwin') {
    return join(home, 'Library/Application Support/Google/Chrome/Default/Local Storage/leveldb');
  }
  return join(home, '.config/google-chrome/Default/Local Storage/leveldb');
}

/** Scan .log/.ldb files (newest first) when CHROME_LEVELDB_LOG is unset or points at a directory. */
function resolveLevelDbScanPaths(): string[] {
  const explicit = process.env.CHROME_LEVELDB_LOG?.trim();
  if (explicit) {
    if (!existsSync(explicit)) return [];
    if (explicit.endsWith('.log') || explicit.endsWith('.ldb')) return [explicit];
    return readdirSync(explicit)
      .filter(f => f.endsWith('.log') || f.endsWith('.ldb'))
      .map(f => join(explicit, f));
  }
  const dir = defaultChromeLevelDbDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.log') || f.endsWith('.ldb'))
    .map(f => join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

function extractTokensFromLog(path: string): Record<string, string> {
  const raw = execSync(`strings ${JSON.stringify(path)}`, { encoding: 'utf8', maxBuffer: 10_000_000 });
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  const found: Record<string, string> = {};
  const jwtRe = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.endsWith('%') && line.length > 3) {
      const key = line.slice(0, -1);
      const val = lines[i + 1];
      if (val && !val.startsWith('_https://') && !val.includes('META')) found[key] = val;
    }
    if (jwtRe.test(line)) found._jwt ??= line;
    if (line === 'idt_token' && jwtRe.test(lines[i + 1] ?? '')) found.idt_token = lines[i + 1];
    if (line.startsWith('access_pp_token') && jwtRe.test(lines[i + 1] ?? '')) found.access_pp_token = lines[i + 1];
  }
  return found;
}

function setEnvVar(key: string, value: string): void {
  const path = '.env';
  const template = existsSync('.env.example') ? readFileSync('.env.example', 'utf8') : '';
  let content = existsSync(path) ? readFileSync(path, 'utf8') : template;
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const line = `${key}="${escaped}"`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  content = re.test(content) ? content.replace(re, line) : `${content.trim()}\n${line}\n`;
  writeFileSync(path, content, 'utf8');
}

async function pickWorkingToken(candidates: string[]): Promise<string | undefined> {
  for (const token of [...new Set(candidates.filter(Boolean))]) {
    const ok = await verifyOneSession(token);
    if (ok.ok) return token;
  }
  return undefined;
}

async function main() {
  const scanPaths = resolveLevelDbScanPaths();
  if (!scanPaths.length) {
    console.error(`Chrome leveldb not found (set CHROME_LEVELDB_LOG or log in via Chrome): ${defaultChromeLevelDbDir()}`);
    process.exit(1);
  }

  const extracted: Record<string, string> = {};
  for (const path of scanPaths) {
    const part = extractTokensFromLog(path);
    for (const [k, v] of Object.entries(part)) {
      if (!extracted[k] || v.length > (extracted[k]?.length ?? 0)) extracted[k] = v;
    }
    if (extracted.access_token_mh && extracted.library_token) break;
  }
  const candidates = [
    extracted.access_token_mh,
    extracted.idt_token,
    extracted.access_pp_token,
    extracted._jwt
  ];

  const working = await pickWorkingToken(candidates);
  if (!working) {
    console.log(JSON.stringify({
      error: 'No valid ONE Bearer token found in Chrome profile',
      keysFound: Object.keys(extracted)
    }, null, 2));
    process.exit(2);
  }

  setEnvVar('SANGFOR_ONE_ACCESS_TOKEN', working);
  if (extracted.library_token) {
    setEnvVar('SANGFOR_KB_TOKEN', extracted.library_token);
    setEnvVar('SANGFOR_LIBRARY_TOKEN', extracted.library_token);
  }

  loadEnvFile('.env');
  const tokens = await resolveAuthTokens(loadOneSessionFromEnv());

  console.log(JSON.stringify({
    keysFound: Object.keys(extracted),
    oneSessionValid: true,
    tokenSources: tokens.sources,
    hasKbToken: Boolean(tokens.kbToken),
    savedToEnv: true
  }, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
