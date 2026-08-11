import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const browserFixture = vi.hoisted(() => {
  const page = {
    url: vi.fn(() => 'http://127.0.0.1:3400/hci'),
    evaluate: vi.fn(async () => ({
      title: 'Mock console',
      url: 'http://127.0.0.1:3400/hci',
      text: 'mock',
    })),
  };
  const context = {
    pages: vi.fn(() => [page]),
    newPage: vi.fn(async () => page),
  };
  const browser = {
    contexts: vi.fn(() => [context]),
    newContext: vi.fn(async () => context),
    close: vi.fn(async () => undefined),
  };
  const launch = vi.fn(async () => browser);
  const connectOverCDP = vi.fn(async () => browser);
  return { browser, launch, connectOverCDP };
});

vi.mock('playwright', () => ({
  chromium: {
    launch: browserFixture.launch,
    connectOverCDP: browserFixture.connectOverCDP,
  },
}));

import { createPlaywrightJmBrowserDriver } from '../packages/sangfor-jm-execution/src/playwright-driver.js';

const evidenceDirs: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SANGFOR_JM_CDP_PROFILES_JSON = JSON.stringify([{
    profileRef: 'lifecycle',
    cdpPort: 9333,
    expectedOrigin: 'http://127.0.0.1:3400',
  }]);
});

afterEach(() => {
  delete process.env.SANGFOR_JM_CDP_PROFILES_JSON;
  for (const path of evidenceDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe('JM Playwright session lifecycle', () => {
  it.each([
    ['managed', undefined],
    ['borrowed', 9333],
  ] as const)('disconnects the %s browser handle on close', async (_kind, cdpPort) => {
    const evidenceDir = mkdtempSync(join(tmpdir(), 'jm-lifecycle-'));
    evidenceDirs.push(evidenceDir);
    const driver = createPlaywrightJmBrowserDriver({ evidenceDir });
    const session = {
      sessionId: `session-${_kind}`,
      origin: 'http://127.0.0.1:3400',
      mode: 'lab',
      ...(cdpPort === undefined ? {} : { cdpPort }),
    } as const;

    await driver.execute(session, {
      schemaVersion: 'browser-execution-request.v1',
      requestId: `request-${_kind}`,
      sessionId: session.sessionId,
      origin: session.origin,
      operation: { kind: 'observe_console' },
    });
    await driver.closeSession(session);

    expect(browserFixture.browser.close).toHaveBeenCalledTimes(1);
  });

  it('closes every retained browser handle during runtime shutdown', async () => {
    const evidenceDir = mkdtempSync(join(tmpdir(), 'jm-lifecycle-all-'));
    evidenceDirs.push(evidenceDir);
    const driver = createPlaywrightJmBrowserDriver({ evidenceDir });

    for (const sessionId of ['session-one', 'session-two']) {
      await driver.execute({
        sessionId,
        origin: 'http://127.0.0.1:3400',
        mode: 'lab',
      }, {
        schemaVersion: 'browser-execution-request.v1',
        requestId: `request-${sessionId}`,
        sessionId,
        origin: 'http://127.0.0.1:3400',
        operation: { kind: 'observe_console' },
      });
    }

    await driver.closeAll();
    await driver.closeAll();

    expect(browserFixture.browser.close).toHaveBeenCalledTimes(2);
  });
});
