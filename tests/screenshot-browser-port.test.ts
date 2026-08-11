import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  BrowserExecutionPort,
  BrowserExecutionResult,
} from '../packages/sangfor-browser-contracts/src/index.js';
import {
  captureConsoleEvidence,
  captureProductScreenshots,
} from '../packages/sangfor-screenshot/src/index.js';

const roots: string[] = [];

function fakePort(artifactRef: string): BrowserExecutionPort {
  return {
    execute: vi.fn(async (request): Promise<BrowserExecutionResult> => ({
      schemaVersion: 'browser-execution-result.v1',
      requestId: request.requestId,
      status: 'PASS',
      mutationAttempted: false,
      readBack: { status: 'PASS' },
      evidence: [{
        artifactRef,
        sha256: 'a'.repeat(64),
        mediaType: 'image/png',
        size: 8,
      }],
    })),
  };
}

describe('screenshot browser port boundaries', () => {
  afterEach(() => {
    delete process.env.SANGFOR_EVIDENCE_ROOT;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('captures product screenshots through the injected port', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sangfor-port-shot-'));
    roots.push(root);
    const artifact = 'artifact://jm/capture.png';
    process.env.SANGFOR_EVIDENCE_ROOT = root;
    const port = fakePort(artifact);
    const expectedFile = join(root, '01_Dashboard.png');

    const output = await captureProductScreenshots({
      product: 'EPP',
      targetUrl: 'http://127.0.0.1:3400/hci',
      outputDir: root,
      menus: [{ menu: 'Dashboard' }],
      sessionId: 'screenshot-session',
      executionPort: port,
      materializeArtifact: async (_artifactRef, destinationPath) => {
        writeFileSync(destinationPath, 'fake-png');
      },
    });

    expect(output.failed).toEqual([]);
    expect(output.captured).toEqual([expectedFile]);
    expect(readFileSync(expectedFile, 'utf8')).toBe('fake-png');
    expect(port.execute).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'screenshot-session',
      operation: expect.objectContaining({ kind: 'capture_console_evidence' }),
    }));
  });

  it.each([
    ['EPP', 9],
    ['IAG', 9],
    ['CC', 7],
  ] as const)('preserves the %s default capture menu set', async (product, expectedCount) => {
    const root = mkdtempSync(join(tmpdir(), 'sangfor-port-defaults-'));
    roots.push(root);
    process.env.SANGFOR_EVIDENCE_ROOT = root;

    const output = await captureProductScreenshots({
      product,
      outputDir: root,
      dryRun: true,
    });

    expect(output.totalScreenshots).toBe(expectedCount);
  });

  it('refuses a product screenshot destination outside the evidence root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sangfor-product-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'sangfor-product-outside-'));
    roots.push(root, outside);
    process.env.SANGFOR_EVIDENCE_ROOT = root;

    await expect(captureProductScreenshots({
      product: 'EPP',
      outputDir: outside,
      dryRun: true,
    })).rejects.toThrow(/CAPTURE_DIR_OUTSIDE_ROOT/);
  });

  it('uses the browser execution port for console evidence', async () => {
    const evidenceRoot = join(process.cwd(), 'data', 'evidence');
    mkdirSync(evidenceRoot, { recursive: true });
    const root = mkdtempSync(join(evidenceRoot, 'sangfor-port-evidence-'));
    roots.push(root);
    const artifact = join(root, 'port-artifact.png');
    writeFileSync(artifact, 'fake-png');
    const port = fakePort(artifact);

    const output = await captureConsoleEvidence({
      product: 'HCI',
      outputDir: root,
      captures: [{
        reqId: '01',
        menuLabel: 'Dashboard',
        menuPath: [{ menu: 'Dashboard' }],
      }],
    }, {
      executionPort: port,
      sessionId: 'console-evidence-session',
      origin: 'http://127.0.0.1:3400',
      materializeArtifact: async (_artifactRef, destinationPath) => {
        writeFileSync(destinationPath, 'fake-png');
      },
    });

    expect(output.chainOk).toBe(true);
    expect(port.execute).toHaveBeenCalledWith(expect.objectContaining({
      operation: expect.objectContaining({ kind: 'capture_console_evidence' }),
    }));
  });
});
