/**
 * Where an authenticated knowledgebase.sangfor.com session comes from: the ONE
 * config, the environment, and the local Safari WebKit localStorage database.
 *
 * This module also re-exports the launcher, page driver, and lifecycle scope so
 * `./kb-browser-session.js` stays the single import path for KB browsing.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadOneSessionFromEnv, resolveAuthTokens } from '../../packages/sangfor-collector/src/index.js';
import type { OneSessionConfig } from '../../packages/sangfor-collector/src/one-session.js';
import { parseBoundaryKbSessionItemTableV1 } from './kb-runtime-boundaries.js';
import type { KbBrowserTokens } from './kb-browser-contracts.js';

export type {
  KbBrowserHandle,
  KbBrowserLauncher,
  KbBrowserTokens
} from './kb-browser-contracts.js';
export {
  createKbContextWithStorage,
  kbStorageStatePath,
  launchKbBrowser,
  resolveKbPersistentLaunchOptions,
  saveKbStorageState
} from './kb-browser-launcher.js';
export { withKbBrowser } from './kb-browser-lifecycle.js';
export {
  injectKbSession,
  openKbViaOne,
  prepareKbPage,
  waitForKbReady
} from './kb-page-session.js';

const SAFARI_WEBKIT_DEFAULT = join(
  process.env.HOME ?? '',
  'Library/Containers/com.apple.Safari/Data/Library/WebKit/WebsiteData/Default'
);

function decodeWebKitLocalStorageValue(hex: string): string {
  const buf = Buffer.from(hex, 'hex');
  if (buf.length >= 4 && buf[1] === 0 && buf[3] === 0) {
    return buf.toString('utf16le').replace(/\0/g, '');
  }
  return buf.toString('utf8');
}

function readSafariKbLocalStorage(): Record<string, string> | undefined {
  const base = process.env.SAFARI_WEBKIT_DEFAULT?.trim() || SAFARI_WEBKIT_DEFAULT;
  if (!existsSync(base)) return undefined;

  let entries: string[];
  try {
    entries = readdirSync(base);
  } catch {
    // macOS sandbox or permission issue — Safari data not accessible
    return undefined;
  }

  for (const entry of entries) {
    const originPath = join(base, entry, entry, 'origin');
    const dbPath = join(base, entry, entry, 'LocalStorage', 'localstorage.sqlite3');
    if (!existsSync(originPath) || !existsSync(dbPath)) continue;
    const origin = readFileSync(originPath, 'utf8');
    if (!origin.includes('knowledgebase.sangfor.com')) continue;
    const out = execSync(
      `sqlite3 -json ${JSON.stringify(dbPath)} "SELECT key, hex(value) AS value_hex FROM ItemTable;"`,
      { encoding: 'utf8', maxBuffer: 50_000_000 }
    );
    const parsed = parseBoundaryKbSessionItemTableV1(out.trim() || '[]');
    const rows: Record<string, string> = {};
    for (const row of parsed) rows[row.key] = decodeWebKitLocalStorageValue(row.value_hex);
    return rows;
  }
  return undefined;
}

export async function resolveKbBrowserTokens(config: OneSessionConfig = loadOneSessionFromEnv()): Promise<KbBrowserTokens> {
  const resolved = await resolveAuthTokens(config);
  const safari = readSafariKbLocalStorage();

  const libraryToken =
    resolved.kbToken?.trim()
    || config.kbToken?.trim()
    || safari?.library_token?.trim()
    || '';

  const tokenByCode =
    process.env.SANGFOR_KB_TOKEN_BY_CODE?.trim()
    || safari?.token_by_code?.trim()
    || libraryToken;

  const oneAccessToken =
    resolved.oneAccessToken?.trim()
    || config.accessToken?.trim()
    || safari?.access_token_mh?.trim()
    || safari?.idt_token?.trim();

  return { libraryToken, tokenByCode, oneAccessToken };
}

export function readSafariLibraryTree(): string | undefined {
  const rows = readSafariKbLocalStorage();
  const tree = rows?.library_tree;
  return tree && tree.length > 100 ? tree : undefined;
}
