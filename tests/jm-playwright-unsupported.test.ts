import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserExecutionRequest } from '../packages/sangfor-browser-contracts/src/index.js';

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
  return { browser };
});

vi.mock('playwright', () => ({
  chromium: {
    launch: vi.fn(async () => browserFixture.browser),
    connectOverCDP: vi.fn(async () => browserFixture.browser),
  },
}));

import { createPlaywrightJmBrowserDriver } from '../packages/sangfor-jm-execution/src/playwright-driver.js';

const evidenceDirs: string[] = [];

afterEach(() => {
  for (const path of evidenceDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe('JM Playwright unsupported operations', () => {
  it.each<BrowserExecutionRequest['operation']>([
    { kind: 'capture_structure' },
    {
      kind: 'extract_authenticated_knowledge',
      sourceUrl: 'http://127.0.0.1:3400/hci',
    },
  ])('returns UNSUPPORTED for $kind', async (operation) => {
    const evidenceDir = mkdtempSync(join(tmpdir(), 'jm-unsupported-'));
    evidenceDirs.push(evidenceDir);
    const driver = createPlaywrightJmBrowserDriver({ evidenceDir });

    const output = await driver.execute({
      sessionId: 'session-unsupported',
      origin: 'http://127.0.0.1:3400',
      mode: 'lab',
    }, {
      schemaVersion: 'browser-execution-request.v1',
      requestId: `request-${operation.kind}`,
      sessionId: 'session-unsupported',
      origin: 'http://127.0.0.1:3400',
      operation,
    });

    expect(output.status).toBe('UNSUPPORTED');
    expect(output.error?.code).toBe('JM_BROWSER_OPERATION_UNSUPPORTED');
  });
});
