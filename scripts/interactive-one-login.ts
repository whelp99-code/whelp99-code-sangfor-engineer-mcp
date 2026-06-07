import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { loadEnvFile } from '../packages/sangfor-collector/src/load-env.js';
import {
  loadOneSessionFromEnv,
  resolveAuthTokens,
  verifyOneSession
} from '../packages/sangfor-collector/src/index.js';

const ONE_URL = (process.env.SANGFOR_ONE_BASE_URL ?? 'https://one.sangfor.com').replace(/\/$/, '');
const WAIT_MS = Number(process.env.SANGFOR_LOGIN_WAIT_MS ?? 600_000);

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

async function readSessionFromPage(page: import('playwright').Page): Promise<{
  accessToken?: string;
  oauthCode?: string;
  url: string;
}> {
  const url = page.url();
  const codeMatch = url.match(/[?&]code=([^&#]+)/);
  const oauthCode = codeMatch ? decodeURIComponent(codeMatch[1]) : undefined;
  let accessToken: string | undefined;
  try {
    accessToken = await page.evaluate(() => {
      const ls = globalThis.localStorage;
      return ls.getItem('access_token_mh')
        ?? ls.getItem('access_token')
        ?? undefined;
    });
  } catch {
    // Page navigated during login — poll again.
  }
  return { accessToken: accessToken ?? undefined, oauthCode, url };
}

async function main() {
  console.error(`Opening ${ONE_URL} — log in with your partner ID/PW in the browser window.`);
  console.error(`Waiting up to ${Math.round(WAIT_MS / 60_000)} minutes for session...`);

  const browser = await chromium.launch({
    headless: false,
    args: ['--start-maximized', '--disable-blink-features=AutomationControlled']
  });
  const context = await browser.newContext({ viewport: null, ignoreHTTPSErrors: true });
  const page = await context.newPage();

  await page.goto(ONE_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });

  const deadline = Date.now() + WAIT_MS;
  let captured: Awaited<ReturnType<typeof readSessionFromPage>> | undefined;

  while (Date.now() < deadline) {
    try {
      captured = await readSessionFromPage(page);
      if (captured.accessToken || captured.oauthCode) break;
    } catch {
      // Transient navigation / frame detach while SSO redirects.
    }
    await page.waitForTimeout(2000);
  }

  if (!captured?.accessToken && !captured?.oauthCode) {
    console.error('Playwright window: no token yet — trying system Chrome profile...');
    await browser.close();
    const { spawnSync } = await import('node:child_process');
    const child = spawnSync('pnpm', ['exec', 'tsx', 'scripts/extract-chrome-one-tokens.ts'], {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: process.env
    });
    process.exit(child.status === 0 ? 0 : 1);
  }

  if (captured.oauthCode) {
    setEnvVar('SANGFOR_OAUTH_CODE', captured.oauthCode);
    process.env.SANGFOR_OAUTH_CODE = captured.oauthCode;
    console.error('Saved SANGFOR_OAUTH_CODE to .env');
  }
  if (captured.accessToken) {
    setEnvVar('SANGFOR_ONE_ACCESS_TOKEN', captured.accessToken);
    process.env.SANGFOR_ONE_ACCESS_TOKEN = captured.accessToken;
    console.error('Saved SANGFOR_ONE_ACCESS_TOKEN to .env (not printed).');
  }

  loadEnvFile('.env');
  const config = loadOneSessionFromEnv();
  const tokens = await resolveAuthTokens(config);
  const oneOk = tokens.oneAccessToken
    ? await verifyOneSession(tokens.oneAccessToken, config.oneBaseUrl)
    : { ok: false };

  const summary = {
    loginUrl: captured.url,
    savedOAuthCode: Boolean(captured.oauthCode),
    savedAccessToken: Boolean(captured.accessToken),
    tokenSources: tokens.sources,
    oneSessionValid: oneOk.ok,
    hasKbToken: Boolean(tokens.kbToken),
    kbBaseUrl: config.kbBaseUrl
  };

  console.log(JSON.stringify(summary, null, 2));
  await browser.close();
  process.exit(oneOk.ok || tokens.kbToken ? 0 : 2);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
