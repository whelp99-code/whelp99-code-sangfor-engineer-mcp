import { chromium } from 'playwright';
import { loadEnvFile } from '../packages/sangfor-collector/src/load-env.js';
import {
  injectKbSession,
  openKbViaOne,
  resolveKbBrowserTokens,
  waitForKbReady
} from './lib/kb-browser-session.js';

loadEnvFile('.env');

async function main() {
  const tokens = await resolveKbBrowserTokens();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await openKbViaOne(page, tokens);
  await page.goto('https://knowledgebase.sangfor.com/home', { waitUntil: 'domcontentloaded' });
  await injectKbSession(page, tokens);
  const ready = await waitForKbReady(page);
  const hci = page.locator('button', { hasText: /^HCI$/ }).first();
  const state = await page.evaluate(() => ({
    url: location.href,
    login: (document.body.innerText || '').includes('Login'),
    links: document.querySelectorAll('a[href*="detailPage"]').length,
    treeLen: localStorage.getItem('library_tree')?.length ?? 0,
    buttons: document.querySelectorAll('.home-page button').length
  }));
  console.log({ ready, hciCount: await hci.count(), ...state });
  await browser.close();
}

main();
