import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { loadEnvFile } from '../packages/sangfor-collector/src/load-env.js';
import {
  loadOneSessionFromEnv,
  resolveAuthTokens,
  verifyOneSession
} from '../packages/sangfor-collector/src/index.js';

const CDP_URL = process.env.SANGFOR_CDP_URL ?? 'http://127.0.0.1:9222';

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

async function main() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const contexts = browser.contexts();
  let accessToken: string | undefined;
  let oauthCode: string | undefined;
  let matchedUrl: string | undefined;

  for (const ctx of contexts) {
    for (const page of ctx.pages()) {
      const url = page.url();
      if (!/sangfor\.com/i.test(url)) continue;
      matchedUrl = url;
      const codeMatch = url.match(/[?&]code=([^&#]+)/);
      if (codeMatch) oauthCode = decodeURIComponent(codeMatch[1]);
      const fromLs = await page.evaluate(() => {
        const keys = Object.keys(localStorage);
        const pick = (name: string) => localStorage.getItem(name);
        return {
          keys,
          access_token_mh: pick('access_token_mh'),
          access_token: pick('access_token'),
          library_token: pick('library_token'),
          token: pick('token')
        };
      });
      accessToken = fromLs.access_token_mh ?? fromLs.access_token ?? undefined;
      if (fromLs.library_token && !process.env.SANGFOR_KB_TOKEN) {
        setEnvVar('SANGFOR_KB_TOKEN', fromLs.library_token);
        process.env.SANGFOR_KB_TOKEN = fromLs.library_token;
      }
      if (accessToken || oauthCode) break;
    }
    if (accessToken || oauthCode) break;
  }

  if (!accessToken && !oauthCode) {
    const urls = contexts.flatMap(c => c.pages().map(p => p.url()));
    console.error(JSON.stringify({ error: 'No ONE session in open Chrome tabs', cdp: CDP_URL, urls }, null, 2));
    process.exit(1);
  }

  if (oauthCode) {
    setEnvVar('SANGFOR_OAUTH_CODE', oauthCode);
    process.env.SANGFOR_OAUTH_CODE = oauthCode;
  }
  if (accessToken) {
    setEnvVar('SANGFOR_ONE_ACCESS_TOKEN', accessToken);
    process.env.SANGFOR_ONE_ACCESS_TOKEN = accessToken;
  }

  loadEnvFile('.env');
  const config = loadOneSessionFromEnv();
  const tokens = await resolveAuthTokens(config);
  const oneOk = tokens.oneAccessToken
    ? await verifyOneSession(tokens.oneAccessToken, config.oneBaseUrl)
    : { ok: false };

  console.log(JSON.stringify({
    capturedFrom: matchedUrl,
    savedOAuthCode: Boolean(oauthCode),
    savedAccessToken: Boolean(accessToken),
    tokenSources: tokens.sources,
    oneSessionValid: oneOk.ok,
    hasKbToken: Boolean(tokens.kbToken)
  }, null, 2));

  await browser.close();
  process.exit(oneOk.ok || tokens.kbToken ? 0 : 2);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
