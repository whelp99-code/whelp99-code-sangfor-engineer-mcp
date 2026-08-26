import { testFileLocalWriteAuthority, testLocalWriteAuthority } from './helpers/local-write-authority.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Registry } from '../apps/control-tower/src/registry.js';
import { PlaybookStore } from '../apps/control-tower/src/playbook-store.js';

describe('Registry device mutators — lock-protected read-modify-write', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'registry-lock-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('createDevice actually acquires devices.json.lock: a pre-held lock blocks it, then it succeeds once released', async () => {
    const reg = new Registry(dir, testLocalWriteAuthority('registry_services', dir));
    const lockPath = join(dir, 'devices.json.lock');
    mkdirSync(lockPath, { recursive: true }); // simulate a concurrent writer holding the lock

    await expect(async () => await reg.createDevice({ name: 'dev1', product: 'HCI_SCP', host: '10.0.0.1' })).rejects.toThrow(/LOCK_TIMEOUT/);
    expect(reg.devices()).toEqual([]); // blocked attempt left no partial write

    rmdirSync(lockPath);
    const device = await reg.createDevice({ name: 'dev1', product: 'HCI_SCP', host: '10.0.0.1' });
    expect(device.name).toBe('dev1');
    expect(existsSync(lockPath)).toBe(false); // released after success
  }, 10_000);

  it('20 sequential createDevice calls each land under their own lock/release cycle with no lost or duplicated writes', async () => {
    const reg = new Registry(dir, testLocalWriteAuthority('registry_services', dir));
    for (let i = 0; i < 20; i += 1) {
      await reg.createDevice({ name: `dev-${i}`, product: 'HCI_SCP', host: `10.0.0.${i}` });
    }
    const devices = reg.devices();
    expect(devices).toHaveLength(20);
    expect(new Set(devices.map((d) => d.id)).size).toBe(20); // every id unique — no clobbered write
    expect(devices.map((d) => d.name).sort()).toEqual(Array.from({ length: 20 }, (_, i) => `dev-${i}`).sort());
  });
});

describe('PlaybookStore — lock-protected read-modify-write', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'playbook-lock-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('create actually acquires playbooks.json.lock: a pre-held lock blocks it, then it succeeds once released', async () => {
    const store = new PlaybookStore(dir, testLocalWriteAuthority('registry_services', dir));
    const lockPath = join(dir, 'playbooks.json.lock');
    mkdirSync(lockPath, { recursive: true });

    await expect(async () => await store.create({
      name: 'pb1', goal: 'goal', authoredBy: 'tester',
      blocks: [{ id: 'b1', type: 'tool', toolId: 'sangfor_advisor_fortios', args: {} }],
    })).rejects.toThrow(/LOCK_TIMEOUT/);
    expect(store.list()).toEqual([]);

    rmdirSync(lockPath);
    const pb = await store.create({
      name: 'pb1', goal: 'goal', authoredBy: 'tester',
      blocks: [{ id: 'b1', type: 'tool', toolId: 'sangfor_advisor_fortios', args: {} }],
    });
    expect(pb.name).toBe('pb1');
    expect(existsSync(lockPath)).toBe(false);
  }, 10_000);
});
