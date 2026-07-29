import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ObserverSessionManager,
  type CdpBrowserSnapshot,
  type CdpPageTarget,
  type ObserverProfile,
  type ObserverTransport,
  type StructuralCapture,
} from '../packages/sangfor-observer/src/index.js';

const PROFILE: ObserverProfile = {
  product: 'ENDPOINT_SECURE',
  expectedOrigin: 'https://10.80.1.106',
  cdpPort: 9333,
  firmwareTruthId: 'epp-6.0.4',
  deviceScope: '018f22e2-79b0-7cc3-8c3c-0f8e5d50a2bf',
};
const PAGE: CdpPageTarget = {
  id: 'page-1',
  url: 'https://10.80.1.106/#/dashboard',
  webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/page-1',
};
const SNAPSHOT: CdpBrowserSnapshot = {
  browserPid: 1234,
  browserAlive: true,
  pages: [{ id: PAGE.id, url: PAGE.url }],
};

class FakeTransport implements ObserverTransport {
  pages = [PAGE];
  before = structuredClone(SNAPSHOT);
  after = structuredClone(SNAPSHOT);
  captures: StructuralCapture[] = [{
    network: [{ method: 'RESPONSE', origin: PROFILE.expectedOrigin, path: '/api/status', resourceType: 'XHR', status: 200 }],
    dom: { elementCount: 10, formCount: 0, iframeCount: 0, shadowHostCount: 0, roleCounts: { navigation: 1 } },
    storageMutationCount: 0,
  }];
  snapshotReads = 0;

  async listPages(): Promise<CdpPageTarget[]> { return structuredClone(this.pages); }
  async snapshot(): Promise<CdpBrowserSnapshot> {
    return structuredClone(this.snapshotReads++ === 0 ? this.before : this.after);
  }
  async captureStructure(): Promise<StructuralCapture> { return structuredClone(this.captures[0]!); }
}

describe('PR-004 observer existing-session boundary', () => {
  let tempDir: string;
  let transport: FakeTransport;
  const safeNow = () => new Date('2026-07-28T06:00:00.000Z'); // 15:00 Asia/Seoul

  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'observer-session-')); transport = new FakeTransport(); });
  afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

  it('attaches only the exact owned profile with exactly one matching page', async () => {
    const manager = new ObserverSessionManager([PROFILE], transport, safeNow);
    const session = await manager.attach({
      product: PROFILE.product,
      expectedOrigin: PROFILE.expectedOrigin,
      cdpPort: PROFILE.cdpPort,
      firmwareTruthId: PROFILE.firmwareTruthId,
    });
    expect(session.target.id).toBe(PAGE.id);
    expect(manager.get(session.handle)?.before).toEqual(SNAPSHOT);
  });

  it('fails closed for 9222, unowned/remote profiles, protection window, and zero or multiple pages', async () => {
    expect(() => new ObserverSessionManager([{ ...PROFILE, cdpPort: 9222 }], transport, safeNow)).toThrow(/RESERVED_CDP_PORT/u);
    const manager = new ObserverSessionManager([PROFILE], transport, safeNow);
    await expect(manager.attach({ ...PROFILE, cdpPort: 9334 })).rejects.toThrow(/CDP_PORT_OWNERSHIP/u);
    await expect(manager.attach({ ...PROFILE, expectedOrigin: 'https://evil.example' })).rejects.toThrow(/OBSERVER_PROFILE_MISMATCH/u);
    const protectedManager = new ObserverSessionManager([PROFILE], transport, () => new Date('2026-07-27T17:00:00.000Z'));
    await expect(protectedManager.attach(PROFILE)).rejects.toThrow(/OBSERVER_PROTECTION_WINDOW/u);
    transport.pages = [];
    await expect(manager.attach(PROFILE)).rejects.toThrow(/AMBIGUOUS_CDP_PAGE/u);
    transport.pages = [PAGE, { ...PAGE, id: 'page-2' }];
    await expect(manager.attach(PROFILE)).rejects.toThrow(/AMBIGUOUS_CDP_PAGE/u);
  });

  it('promotes only structurally minimized encrypted capture when browser invariants hold', async () => {
    const manager = new ObserverSessionManager([PROFILE], transport, safeNow);
    const session = await manager.attach(PROFILE);
    const summary = await manager.capture({
      sessionHandle: session.handle,
      durationMs: 0,
      capturesDir: join(tempDir, 'captures'),
      stagingRoot: join(tempDir, 'staging'),
      keyring: { activeKeyId: 'key-1', keys: { 'key-1': Buffer.alloc(32, 7) } },
      firmwareVersion: '6.0.4',
    });
    expect(summary.path).toMatch(/\.enc$/u);
    expect(manager.get(session.handle)).toBeNull();
  });

  it('burns the session and refuses storage mutation or page/PID/liveness drift', async () => {
    const keyring = { activeKeyId: 'key-1', keys: { 'key-1': Buffer.alloc(32, 7) } };
    for (const mutate of [
      () => { transport.captures[0]!.storageMutationCount = 1; },
      () => { transport.after.browserPid = 9999; },
      () => { transport.after.browserAlive = false; },
      () => { transport.after.pages[0]!.url = `${PAGE.url}/changed`; },
      () => { transport.after.pages.push({ id: 'page-2', url: PAGE.url }); },
    ]) {
      transport = new FakeTransport();
      mutate();
      const manager = new ObserverSessionManager([PROFILE], transport, safeNow);
      const session = await manager.attach(PROFILE);
      await expect(manager.capture({
        sessionHandle: session.handle,
        durationMs: 0,
        capturesDir: join(tempDir, randomName()),
        stagingRoot: join(tempDir, randomName()),
        keyring,
      })).rejects.toThrow(/OBSERVER_(?:MUTATION_SIGNAL|INTEGRITY_ERROR)/u);
      expect(manager.get(session.handle)).toBeNull();
    }
  });
});

function randomName(): string {
  return `x-${Math.random().toString(16).slice(2)}`;
}
