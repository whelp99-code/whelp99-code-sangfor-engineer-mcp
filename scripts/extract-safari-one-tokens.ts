/**
 * Read ONE / Knowledge Base tokens from Safari WebKit localStorage (macOS).
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnvFile } from '../packages/sangfor-collector/src/load-env.js';
import {
  fetchKbArticleMarkdown,
  loadOneSessionFromEnv,
  parseKbCategoryNavigation,
  resolveAuthTokens,
  resolveKbTokenFromOne,
  verifyOneSession
} from '../packages/sangfor-collector/src/index.js';

const SAFARI_WEBKIT_DEFAULT = join(
  process.env.HOME ?? '',
  'Library/Containers/com.apple.Safari/Data/Library/WebKit/WebsiteData/Default'
);

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

/** Safari WebKit stores many localStorage values as UTF-16LE blobs. */
function decodeWebKitLocalStorageValue(hex: string): string {
  const buf = Buffer.from(hex, 'hex');
  if (buf.length >= 4 && buf[1] === 0 && buf[3] === 0) {
    return buf.toString('utf16le').replace(/\0/g, '');
  }
  return buf.toString('utf8');
}

function readItemTable(dbPath: string): Record<string, string> {
  const out = execSync(
    `sqlite3 -json ${JSON.stringify(dbPath)} "SELECT key, hex(value) AS value_hex FROM ItemTable;"`,
    { encoding: 'utf8', maxBuffer: 20_000_000
  });
  const parsed = JSON.parse(out.trim() || '[]') as Array<{ key: string; value_hex: string }>;
  const rows: Record<string, string> = {};
  for (const row of parsed) rows[row.key] = decodeWebKitLocalStorageValue(row.value_hex);
  return rows;
}

function findSafariLocalStorage(hostSuffix: string): Record<string, string> | undefined {
  const base = process.env.SAFARI_WEBKIT_DEFAULT?.trim() || SAFARI_WEBKIT_DEFAULT;
  if (!existsSync(base)) return undefined;

  for (const entry of readdirSync(base)) {
    const originPath = join(base, entry, entry, 'origin');
    const dbPath = join(base, entry, entry, 'LocalStorage', 'localstorage.sqlite3');
    if (!existsSync(originPath) || !existsSync(dbPath)) continue;
    const origin = readFileSync(originPath, 'utf8');
    if (!origin.includes(hostSuffix)) continue;
    const mtime = statSync(dbPath).mtimeMs;
    const rows = readItemTable(dbPath);
    return { ...rows, _dbPath: dbPath, _mtime: String(mtime) };
  }
  return undefined;
}

async function pickWorkingOneToken(candidates: string[]): Promise<string | undefined> {
  for (const token of [...new Set(candidates.filter(Boolean))]) {
    const ok = await verifyOneSession(token);
    if (ok.ok) return token;
  }
  return undefined;
}

async function pickWorkingKbToken(
  candidates: string[],
  kbBaseUrl: string
): Promise<string | undefined> {
  const nav = JSON.parse(
    await fetch(`${kbBaseUrl.replace(/\/$/, '')}/category-navigation.json`).then(r => r.text())
  );
  const article = parseKbCategoryNavigation(nav, kbBaseUrl)[0];
  if (!article) return candidates[0];

  for (const token of [...new Set(candidates.filter(Boolean))]) {
    const md = await fetchKbArticleMarkdown(article, token, kbBaseUrl);
    if (md && md.length > 50) return token;
  }
  return undefined;
}

async function main() {
  const oneRows = findSafariLocalStorage('one.sangfor.com');
  const kbRows = findSafariLocalStorage('knowledgebase.sangfor.com');

  if (!oneRows && !kbRows) {
    console.error(`No Safari localStorage for Sangfor under ${SAFARI_WEBKIT_DEFAULT}`);
    process.exit(1);
  }

  const oneCandidates = oneRows
    ? [oneRows.idt_token, oneRows.access_token_mh, oneRows.access_pp_token]
    : [];
  const workingOne = await pickWorkingOneToken(oneCandidates);

  const kbBase = process.env.SANGFOR_KB_BASE_URL ?? 'https://knowledgebase.sangfor.com';

  if (workingOne) {
    setEnvVar('SANGFOR_ONE_ACCESS_TOKEN', workingOne);
  }

  let kbToken: string | undefined;
  if (workingOne) {
    kbToken = await resolveKbTokenFromOne(workingOne, kbBase);
  }
  if (!kbToken && kbRows) {
    kbToken = await pickWorkingKbToken(
      [kbRows.library_token, kbRows.token_by_code, workingOne].filter((t): t is string => Boolean(t)),
      kbBase
    );
    kbToken ??= kbRows.library_token || kbRows.token_by_code;
  }
  if (kbToken) {
    setEnvVar('SANGFOR_KB_TOKEN', kbToken);
    setEnvVar('SANGFOR_LIBRARY_TOKEN', kbToken);
  }
  if (kbRows?.token_by_code && kbRows.token_by_code !== kbToken) {
    setEnvVar('SANGFOR_KB_TOKEN_BY_CODE', kbRows.token_by_code);
  }

  loadEnvFile('.env');
  const tokens = await resolveAuthTokens(loadOneSessionFromEnv());
  const oneOk = tokens.oneAccessToken
    ? await verifyOneSession(tokens.oneAccessToken)
    : { ok: false };

  console.log(JSON.stringify({
    safariOneKeys: oneRows ? Object.keys(oneRows).filter(k => !k.startsWith('_')) : [],
    safariKbKeys: kbRows ? Object.keys(kbRows).filter(k => !k.startsWith('_')) : [],
    savedOneToken: Boolean(workingOne),
    savedKbToken: Boolean(kbToken),
    oneSessionValid: oneOk.ok,
    hasKbToken: Boolean(tokens.kbToken),
    tokenSources: tokens.sources
  }, null, 2));

  process.exit(oneOk.ok || tokens.kbToken ? 0 : 2);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
