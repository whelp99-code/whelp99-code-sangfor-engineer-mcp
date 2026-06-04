import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { loadEnvFile } from '../packages/sangfor-collector/src/load-env.js';
import {
  loadOneSessionFromEnv,
  resolveAuthTokens,
  verifyOneSession
} from '../packages/sangfor-collector/src/index.js';

const LEVELDB_LOG = process.env.CHROME_LEVELDB_LOG
  ?? `${process.env.HOME}/.config/google-chrome/Default/Local Storage/leveldb/000003.log`;

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
  if (!existsSync(LEVELDB_LOG)) {
    console.error(`Chrome storage log not found: ${LEVELDB_LOG}`);
    process.exit(1);
  }

  const extracted = extractTokensFromLog(LEVELDB_LOG);
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
  if (extracted.library_token) setEnvVar('SANGFOR_KB_TOKEN', extracted.library_token);

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
