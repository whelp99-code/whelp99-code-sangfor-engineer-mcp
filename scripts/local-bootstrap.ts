import { existsSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { loadEnvFile } from '../packages/sangfor-collector/src/load-env.js';
import { loadOneSessionFromEnv, resolveAuthTokens, verifyOneSession } from '../packages/sangfor-collector/src/index.js';

function run(cmd: string, args: string[]): number {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: process.cwd(), env: process.env });
  return r.status ?? 1;
}

async function main() {
  console.log('=== Sangfor Engineer MCP — local bootstrap ===\n');

  if (!existsSync('node_modules')) {
    console.log('→ pnpm install');
    if (run('pnpm', ['install']) !== 0) process.exit(1);
  }

  if (!existsSync('.env')) {
    if (!existsSync('.env.example')) {
      console.error('Missing .env.example');
      process.exit(1);
    }
    copyFileSync('.env.example', '.env');
    console.log('→ Created .env from .env.example — set tokens or run: pnpm run login:one\n');
  }

  loadEnvFile('.env');
  const config = loadOneSessionFromEnv();
  const hasAuth = Boolean(config.accessToken || config.oauthCode || config.kbToken);

  if (!hasAuth) {
    console.log('No ONE/KB token in .env.');
    console.log('  pnpm run login:one        # open browser, ID/PW login');
    console.log('  pnpm run login:one:capture  # if already logged in Chrome\n');
    process.exit(0);
  }

  const tokens = await resolveAuthTokens(config);
  const oneOk = tokens.oneAccessToken
    ? await verifyOneSession(tokens.oneAccessToken, config.oneBaseUrl)
    : { ok: false };

  console.log(JSON.stringify({
    oneSessionValid: oneOk.ok,
    hasKbToken: Boolean(tokens.kbToken),
    sources: tokens.sources
  }, null, 2));

  if (!oneOk.ok && !tokens.kbToken) {
    console.error('\nToken invalid — run: pnpm run login:one');
    process.exit(2);
  }

  console.log('\n→ Full learning pipeline (learn:all)');
  process.env.SANGFOR_COMMUNITY_MAX_THREADS = process.env.SANGFOR_COMMUNITY_MAX_THREADS ?? 'all';
  process.env.SANGFOR_KB_MAX_ARTICLES = process.env.SANGFOR_KB_MAX_ARTICLES ?? 'all';
  process.env.SANGFOR_FINETUNE_MAX_EXAMPLES = process.env.SANGFOR_FINETUNE_MAX_EXAMPLES ?? 'all';
  process.env.SANGFOR_INCLUDE_DEMO_DOCS = process.env.SANGFOR_INCLUDE_DEMO_DOCS ?? '1';

  const steps: Array<[string, string[]]> = [
    ['pnpm', ['run', 'learn:sources']],
    ['pnpm', ['run', 'learn:ingest-seeds']],
    ['pnpm', ['run', 'learn:rebuild-finetune']],
    ['pnpm', ['run', 'learn:finalize']]
  ];

  for (const [cmd, args] of steps) {
    if (run(cmd, args) !== 0) process.exit(1);
  }

  console.log('\n=== Local bootstrap complete ===');
  console.log('Report: data/sources/learning-complete.json');
  console.log('MCP:    pnpm run dev:mcp');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
