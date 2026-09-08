import { describe, expect, it, vi } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright';
import {
  KbBrowserLaunchError,
  createKbPersistentHandle
} from '../scripts/lib/kb-browser-launcher.js';

/**
 * A persistent context driven by injection: `browser()` is the only value under
 * test, so every other member is the smallest stand-in that still records how
 * the launcher used it.
 */
function injectContext(driver: {
  readonly browser: Browser | null;
  readonly pages: readonly Page[];
  readonly close?: () => Promise<void>;
}): {
  readonly context: BrowserContext;
  readonly close: () => Promise<void>;
  readonly newPage: () => Promise<Page>;
  readonly openedPage: Page;
} {
  const openedPage = {} as Page;
  const close = vi.fn(driver.close ?? (async () => {}));
  const newPage = vi.fn(async () => openedPage);
  // Checked against the real interface, so a Playwright signature change breaks
  // the fake instead of letting it drift away from the contract under test.
  const members: Partial<BrowserContext> = {
    browser: () => driver.browser,
    pages: () => [...driver.pages],
    newPage,
    close
  };
  return { context: members as BrowserContext, close, newPage, openedPage };
}

describe('createKbPersistentHandle', () => {
  it('rejects with a typed launch error when the context has no owning browser', async () => {
    // Given a persistent context whose owning browser is unavailable.
    const { context } = injectContext({ browser: null, pages: [] });

    // When a handle is requested.
    const settled = createKbPersistentHandle(context);

    // Then the caller gets a named, coded failure instead of a null browser.
    await expect(settled).rejects.toBeInstanceOf(KbBrowserLaunchError);
    await expect(settled).rejects.toMatchObject({
      name: 'KbBrowserLaunchError',
      code: 'PERSISTENT_CONTEXT_HAS_NO_BROWSER'
    });
  });

  it('closes the acquired context when it has no owning browser', async () => {
    // Given a persistent context whose owning browser is unavailable.
    const { context, close } = injectContext({ browser: null, pages: [] });

    // When a handle is requested.
    await createKbPersistentHandle(context).catch(() => undefined);

    // Then the context it acquired is released rather than leaked.
    expect(close).toHaveBeenCalledOnce();
  });

  it('opens no page when the context has no owning browser', async () => {
    // Given a persistent context whose owning browser is unavailable.
    const { context, newPage } = injectContext({ browser: null, pages: [] });

    // When a handle is requested.
    await createKbPersistentHandle(context).catch(() => undefined);

    // Then it never acquires a page it would have to leak.
    expect(newPage).not.toHaveBeenCalled();
  });

  it('keeps the launch failure as the thrown error when closing the context also fails', async () => {
    // Given a context that has no browser and also fails to close.
    const closeFailure = new Error('close failure');
    const { context } = injectContext({
      browser: null,
      pages: [],
      close: async () => {
        throw closeFailure;
      }
    });

    // When a handle is requested.
    const settled = createKbPersistentHandle(context);

    // Then the reason the launch failed wins, with the close failure carried on it.
    await expect(settled).rejects.toBeInstanceOf(KbBrowserLaunchError);
    await expect(settled).rejects.toMatchObject({ cause: closeFailure });
  });

  it('binds the handle to the browser the context reports', async () => {
    // Given a persistent context owned by a browser.
    const owningBrowser = {} as Browser;
    const { context } = injectContext({ browser: owningBrowser, pages: [] });

    // When a handle is requested.
    const handle = await createKbPersistentHandle(context);

    // Then the handle exposes that exact browser and context.
    expect(handle.browser).toBe(owningBrowser);
    expect(handle.context).toBe(context);
  });

  it('reuses the page the context already has', async () => {
    // Given a persistent context that already opened a page.
    const existingPage = {} as Page;
    const { context, newPage } = injectContext({
      browser: {} as Browser,
      pages: [existingPage]
    });

    // When a handle is requested.
    const handle = await createKbPersistentHandle(context);

    // Then the existing page is adopted rather than a second one opened.
    expect(handle.page).toBe(existingPage);
    expect(newPage).not.toHaveBeenCalled();
  });

  it('opens a page when the context has none', async () => {
    // Given a persistent context with no page yet.
    const { context, openedPage } = injectContext({ browser: {} as Browser, pages: [] });

    // When a handle is requested.
    const handle = await createKbPersistentHandle(context);

    // Then the handle carries the newly opened page.
    expect(handle.page).toBe(openedPage);
  });

  it('closes the context when the handle is closed', async () => {
    // Given a handle built from a healthy persistent context.
    const { context, close } = injectContext({ browser: {} as Browser, pages: [] });
    const handle = await createKbPersistentHandle(context);

    // When the caller closes the handle.
    await handle.close();

    // Then the persistent context is closed, keeping the profile browser owned by it.
    expect(close).toHaveBeenCalledOnce();
  });
});
