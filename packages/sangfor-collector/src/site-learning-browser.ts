import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright';
import type { SiteLearningOptions } from './site-learning-types.js';

export function resolveSafeCrawlUserDataDir(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const requested = resolve(value);
  const temporaryRoot = resolve(tmpdir());
  const allowed = requested === temporaryRoot || requested.startsWith(`${temporaryRoot}/`);
  if (!allowed) throw new Error(`TWO_SITE_PROFILE_NOT_ISOLATED: ${requested}`);
  return requested;
}

export async function delay(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return;
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

export async function pageText(page: Page): Promise<{ title: string; text: string; url: string }> {
  return page.evaluate(() => {
    const postBodies = [...document.querySelectorAll<HTMLElement>('[id^="postmessage_"], .t_f')]
      .map((element) => element.innerText.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    if (postBodies.length > 0) {
      const heading = document.querySelector('h1,h2,.ts h1');
      return {
        title: (heading?.textContent || document.title || location.href).replace(/\s+/g, ' ').trim(),
        text: postBodies.join('\n\n'),
        url: location.href,
      };
    }
    const candidates = [
      '.doc-content', '.html-content', '.rich-text', '.article-detail', '.detail-page',
      '.t_f', '#postlist', '#ct', 'article', 'main', '#app', 'body',
    ];
    let best: HTMLElement | null = null;
    for (const selector of candidates) {
      for (const element of document.querySelectorAll<HTMLElement>(selector)) {
        if (!best || element.innerText.length > best.innerText.length) best = element;
      }
    }
    const heading = document.querySelector('h1,h2,.article-title,.ts h1');
    return {
      title: (heading?.textContent || document.title || location.href).replace(/\s+/g, ' ').trim(),
      text: (best?.innerText || document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 100_000),
      url: location.href,
    };
  });
}

export async function navigateAndExtract(
  page: Page,
  url: string,
): Promise<{ title: string; text: string; url: string }> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  return pageText(page);
}

export async function launchContext(options: SiteLearningOptions): Promise<BrowserContext> {
  const executablePath = options.browserExecutablePath?.trim();
  const userDataDir = resolveSafeCrawlUserDataDir(options.userDataDir);
  if (userDataDir) {
    return chromium.launchPersistentContext(userDataDir, {
      ...(executablePath ? { executablePath } : { channel: 'chrome' as const }),
      headless: false,
      args: ['--profile-directory=Default'],
      ignoreHTTPSErrors: true,
    });
  }
  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : { channel: 'chrome' as const }),
    headless: true,
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  context.on('close', () => browser.close().catch(() => {}));
  return context;
}
