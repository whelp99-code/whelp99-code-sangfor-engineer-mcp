import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const browserFixture = vi.hoisted(() => {
  const page = {
    url: vi.fn(() => 'http://127.0.0.1:3400/hci'),
    evaluate: vi.fn(async () => ({
      title: 'Mock console',
      url: 'http://127.0.0.1:3400/hci',
      text: 'mock',
    })),
    screenshot: vi.fn(async ({ path }: { path: string }) => {
      writeFileSync(path, 'fake-png');
    }),
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

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const path of cleanupPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe('JM Playwright artifact confinement', () => {
  it('hashes hostile request ids and exposes only an opaque artifact reference', async () => {
    const evidenceDir = mkdtempSync(join(tmpdir(), 'jm-artifact-'));
    cleanupPaths.push(evidenceDir);
    const escapedPath = join(tmpdir(), `${basename(evidenceDir)}-escaped.png`);
    rmSync(escapedPath, { force: true });
    cleanupPaths.push(escapedPath);
    const driver = createPlaywrightJmBrowserDriver({ evidenceDir });

    const output = await driver.execute({
      sessionId: 'session-artifact',
      origin: 'http://127.0.0.1:3400',
      mode: 'lab',
    }, {
      schemaVersion: 'browser-execution-request.v1',
      requestId: `../${basename(evidenceDir)}-escaped`,
      sessionId: 'session-artifact',
      origin: 'http://127.0.0.1:3400',
      operation: {
        kind: 'perform_console_action',
        action: { type: 'screenshot', target: 'current-page', dryRun: true },
      },
    });

    const artifactRef = output.evidence[0]?.artifactRef;
    expect(artifactRef).toMatch(/^artifact:\/\/jm\/[a-f0-9]{64}$/);
    expect(existsSync(escapedPath)).toBe(false);
    expect(readdirSync(evidenceDir)).toHaveLength(1);

    const materialized = join(evidenceDir, 'materialized.png');
    await driver.materializeArtifact(artifactRef!, materialized);
    expect(existsSync(materialized)).toBe(true);
  });
});
