/**
 * Open Knowledge Base from ONE in system Chrome profile; poll for library_token.
 */
import { existsSync } from 'node:fs';
import { execSync, spawnSync } from 'node:child_process';
import { chromium } from 'playwright';

const PROFILE = process.env.CHROME_USER_DATA ?? `${process.env.HOME}/.config/google-chrome`;
const WAIT_MS = Number(process.env.SANGFOR_KB_WAIT_MS ?? 120_000);

async function hasLibraryToken(): Promise<boolean> {
  const log = `${PROFILE}/Default/Local Storage/leveldb/000003.log`;
  if (!existsSync(log)) return false;
  const raw = execSync(`strings ${JSON.stringify(log)}`, { encoding: 'utf8', maxBuffer: 10_000_000 });
  return /library_token%/.test(raw) || /library_token/.test(raw);
}

async function main() {
  if (await hasLibraryToken()) {
    spawnSync('pnpm', ['exec', 'tsx', 'scripts/extract-chrome-one-tokens.ts'], { stdio: 'inherit', cwd: process.cwd() });
    return;
  }

  const context = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chrome',
    headless: false,
    args: ['--profile-directory=Default'],
    ignoreHTTPSErrors: true
  });
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto('https://one.sangfor.com', { waitUntil: 'domcontentloaded', timeout: 60_000 });

  const kbLink = page.locator('a[href*="knowledge"], a[href*="knowledgebase"]').first();
  if (await kbLink.count()) {
    await kbLink.click({ timeout: 15_000 }).catch(() => {});
  } else {
    await page.goto('https://knowledgebase.sangfor.com', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  }

  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    if (await hasLibraryToken()) break;
    await page.waitForTimeout(3000);
  }

  await context.close();

  if (await hasLibraryToken()) {
    spawnSync('pnpm', ['run', 'login:one:capture'], { stdio: 'inherit', cwd: process.cwd() });
    spawnSync('pnpm', ['exec', 'tsx', 'scripts/resolve-kb-token.ts'], { stdio: 'inherit', cwd: process.cwd() });
  } else {
    console.error('library_token not found — open Knowledge from ONE manually, then run: pnpm run login:one:capture');
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
