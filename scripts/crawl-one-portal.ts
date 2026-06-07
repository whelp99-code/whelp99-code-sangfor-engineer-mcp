/**
 * Capture Sangfor ONE portal sections as markdown (uses ONE access token pages if needed).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { loadEnvFile } from '../packages/sangfor-collector/src/load-env.js';
import { loadOneSessionFromEnv } from '../packages/sangfor-collector/src/index.js';

loadEnvFile('.env');

const CARDS = [
  'Deal Reg', 'Partner-X', 'Product Selection', 'Quotation', 'Demo unit license',
  'KB', 'Community', 'Solvia Chatbot', 'Demo Platform', 'Sangfor Support',
  'E-learning', 'Exam & Certification'
];

async function main() {
  const cfg = loadOneSessionFromEnv();
  const token = cfg.accessToken;
  if (!token) {
    console.error('ONE token missing — run pnpm run login:one:safari');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(cfg.oneBaseUrl ?? 'https://one.sangfor.com', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.evaluate((t) => {
    localStorage.setItem('access_token_mh', t);
  }, token);
  await page.goto('https://one.sangfor.com/ml/portal', { waitUntil: 'networkidle', timeout: 90_000 }).catch(() => {});

  const rawDir = 'data/sources/raw';
  mkdirSync(rawDir, { recursive: true });

  const portalText = await page.evaluate(() => (document.body.innerText || '').slice(0, 15000));
  writeFileSync(join(rawDir, 'browser_one_portal_home.md'), [
    '---', 'id: browser_one_portal', 'source: one_portal', 'sourceUrl: https://one.sangfor.com/ml/portal',
    'product: HCI', 'trustLevel: official', `fetchedAt: ${new Date().toISOString()}`, '---', '',
    '# Sangfor ONE Partner Portal', '', portalText
  ].join('\n'), 'utf8');

  let opened = 0;
  for (const title of CARDS) {
    try {
      const card = page.locator('h3.card-title', { hasText: title }).first();
      if (!(await card.count())) continue;
      await card.click({ timeout: 10_000 });
      await page.waitForTimeout(2500);
      const url = page.url();
      const text = await page.evaluate(() => (document.body.innerText || '').slice(0, 20000));
      const safe = title.replace(/[^a-zA-Z0-9]+/g, '_');
      writeFileSync(join(rawDir, `browser_one_${safe}.md`), [
        '---', `id: browser_one_${safe}`, 'source: one_portal', `sourceUrl: ${url}`,
        'product: HCI', 'trustLevel: official', `fetchedAt: ${new Date().toISOString()}`, '---', '',
        `# ONE: ${title}`, '', text
      ].join('\n'), 'utf8');
      opened += 1;
      await page.goto('https://one.sangfor.com/ml/portal', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    } catch (err) {
      console.error(`skip ${title}: ${err}`);
    }
  }

  await browser.close();
  console.log(JSON.stringify({ portal: true, cards: opened }, null, 2));
}

main();
