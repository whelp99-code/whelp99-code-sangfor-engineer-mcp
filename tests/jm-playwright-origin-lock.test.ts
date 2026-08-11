import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const browserFixture = vi.hoisted(() => {
  const state = {
    currentUrl: 'http://127.0.0.1:3400/hci',
    navigateOnClick: false,
    pages: [] as Array<Record<string, unknown>>,
  };
  const target = {
    count: vi.fn(async () => 1),
    click: vi.fn(async () => {
      if (state.navigateOnClick) state.currentUrl = 'https://attacker.example/landing';
    }),
  };
  const page = {
    url: vi.fn(() => state.currentUrl),
    evaluate: vi.fn(async () => ({
      title: 'Mock console',
      url: state.currentUrl,
      text: 'mock',
    })),
    locator: vi.fn(() => ({
      evaluateAll: vi.fn(async () => [0]),
      nth: vi.fn(() => target),
    })),
    getByText: vi.fn(() => target),
    waitForResponse: vi.fn(async () => undefined),
    screenshot: vi.fn(async ({ path }: { path: string }) => {
      writeFileSync(path, 'fake-png');
    }),
  };
  const secondPage = {
    ...page,
    url: vi.fn(() => 'http://127.0.0.1:3400/second'),
  };
  state.pages = [page];
  const context = {
    pages: vi.fn(() => state.pages),
    newPage: vi.fn(async () => page),
  };
  const browser = {
    contexts: vi.fn(() => [context]),
    newContext: vi.fn(async () => context),
    close: vi.fn(async () => undefined),
  };
  return { browser, page, secondPage, state };
});

vi.mock('playwright', () => ({
  chromium: {
    launch: vi.fn(async () => browserFixture.browser),
    connectOverCDP: vi.fn(async () => browserFixture.browser),
  },
}));

import { createPlaywrightJmBrowserDriver } from '../packages/sangfor-jm-execution/src/playwright-driver.js';

const evidenceDirs: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SANGFOR_JM_CDP_PROFILES_JSON = JSON.stringify([{
    profileRef: 'origin-lock',
    cdpPort: 9333,
    expectedOrigin: 'http://127.0.0.1:3400',
  }]);
  browserFixture.state.currentUrl = 'http://127.0.0.1:3400/hci';
  browserFixture.state.navigateOnClick = false;
  browserFixture.state.pages = [browserFixture.page];
});

afterEach(() => {
  delete process.env.SANGFOR_JM_CDP_PROFILES_JSON;
  for (const path of evidenceDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function driver() {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'jm-origin-lock-'));
  evidenceDirs.push(evidenceDir);
  return createPlaywrightJmBrowserDriver({ evidenceDir });
}

const session = {
  sessionId: 'session-origin-lock',
  origin: 'http://127.0.0.1:3400',
  mode: 'lab',
  cdpPort: 9333,
} as const;

describe('JM Playwright page and origin lock', () => {
  it('refuses an ambiguous borrowed browser with multiple intended pages', async () => {
    browserFixture.state.pages = [browserFixture.page, browserFixture.secondPage];

    await expect(driver().execute(session, {
      schemaVersion: 'browser-execution-request.v1',
      requestId: 'request-ambiguous-pages',
      sessionId: session.sessionId,
      origin: session.origin,
      operation: { kind: 'observe_console' },
    })).rejects.toThrow(/ambiguous|exactly one/i);
  });

  it('refuses evidence after an action navigates outside the locked origin', async () => {
    browserFixture.state.navigateOnClick = true;

    await expect(driver().execute(session, {
      schemaVersion: 'browser-execution-request.v1',
      requestId: 'request-cross-origin-click',
      sessionId: session.sessionId,
      origin: session.origin,
      operation: {
        kind: 'perform_console_action',
        action: { type: 'click', target: 'Continue', dryRun: false },
      },
    })).rejects.toThrow(/origin.*changed|outside.*origin/i);
  });

  it('does not require a mutating HTTP response for a client-side click', async () => {
    vi.mocked(browserFixture.page.waitForResponse)
      .mockRejectedValueOnce(new Error('No mutating response was emitted'));

    const result = await driver().execute(session, {
      schemaVersion: 'browser-execution-request.v1',
      requestId: 'request-client-side-click',
      sessionId: session.sessionId,
      origin: session.origin,
      operation: {
        kind: 'perform_console_action',
        action: { type: 'click', target: 'Open local panel', dryRun: false },
      },
    });

    expect(result.status).toBe('INDETERMINATE');
    expect(result.mutationAttempted).toBe(true);
    expect(browserFixture.page.waitForResponse).not.toHaveBeenCalled();
  });
});
