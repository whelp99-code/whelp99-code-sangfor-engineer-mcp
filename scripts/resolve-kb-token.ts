import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { loadEnvFile } from '../packages/sangfor-collector/src/load-env.js';
import {
  fetchKbArticleMarkdown,
  loadOneSessionFromEnv,
  parseKbCategoryNavigation,
  resolveAuthTokens,
  resolveKbTokenFromOne
} from '../packages/sangfor-collector/src/index.js';

loadEnvFile('.env');

async function main() {
  const config = loadOneSessionFromEnv();
  const tokens = await resolveAuthTokens(config);
  const kbBase = config.kbBaseUrl ?? 'https://knowledgebase.sangfor.com';

  let kbToken = tokens.kbToken;
  if (!kbToken && tokens.oneAccessToken) {
    kbToken = await resolveKbTokenFromOne(tokens.oneAccessToken, kbBase);
  }

  const navJson = JSON.parse(await fetch(`${kbBase}/category-navigation.json`).then(r => r.text()));
  const article = parseKbCategoryNavigation(navJson, kbBase)[0];

  const markdownResults: Record<string, boolean> = {};
  if (article) {
    for (const [label, token] of [
      ['kbToken', kbToken],
      ['oneAccessToken', tokens.oneAccessToken]
    ] as const) {
      if (!token) continue;
      const md = await fetchKbArticleMarkdown(article, token, kbBase);
      markdownResults[label] = Boolean(md && md.length > 50);
    }
  }

  if (kbToken) {
    const path = '.env';
    let content = existsSync(path) ? readFileSync(path, 'utf8') : '';
    const line = `SANGFOR_KB_TOKEN="${kbToken.replace(/"/g, '\\"')}"`;
    content = /^SANGFOR_KB_TOKEN=/m.test(content)
      ? content.replace(/^SANGFOR_KB_TOKEN=.*$/m, line)
      : `${content.trim()}\n${line}\n`;
    writeFileSync(path, content);
  }

  console.log(JSON.stringify({
    tokenSources: tokens.sources,
    hasKbToken: Boolean(kbToken),
    markdownResults
  }, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
