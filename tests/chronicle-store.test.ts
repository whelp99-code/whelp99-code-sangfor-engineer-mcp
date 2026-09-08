import { testLocalWriteAuthority } from './helpers/local-write-authority.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  canonicalize,
  getDiff,
  getHead,
  listSnapshots,
  recordSnapshot,
} from '../packages/sangfor-chronicle/src/index.js';

describe('@sangfor/chronicle — content-addressed snapshot store', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'chronicle-store-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('canonicalizes recursively-sorted keys and excludes ephemeral keys from the hash', async () => {
    const canonical = canonicalize(
      { b: 1, a: { z: [3, { y: 2, x: 1 }], m: 'v' }, uptimeSeconds: 99 },
      ['uptimeSeconds'],
    );
    expect(canonical).toBe('{"a":{"m":"v","z":[3,{"x":1,"y":2}]},"b":1}');
  });

  it('records a first snapshot with a sha256 content address, no parent, and an all-added diff', async () => {
    const r = await recordSnapshot({
      deviceId: 'dev-1',
      observed: { firmware: '8.0.75', haEnabled: true },
      capturedAt: '2026-08-01T00:00:00.000Z',
      dir,
    authority: testLocalWriteAuthority('config_chronicle_state', dir)});

    expect(r.created).toBe(true);
    expect(r.parentHash).toBeUndefined();
    expect(r.hash).toBe(
      createHash('sha256').update(canonicalize({ firmware: '8.0.75', haEnabled: true }, [])).digest('hex'),
    );
    expect(r.snapshot.deviceId).toBe('dev-1');
    expect(r.snapshot.capturedAt).toBe('2026-08-01T00:00:00.000Z');
    expect(r.snapshot.diff).toEqual([
      { key: 'firmware', before: undefined, after: '8.0.75', changeClass: 'added' },
      { key: 'haEnabled', before: undefined, after: true, changeClass: 'added' },
    ]);
    expect(getHead('dev-1', dir)?.hash).toBe(r.hash);
  });

  it('links the next snapshot to the previous head and computes a semantic write-time diff', async () => {
    const first = await recordSnapshot({
      deviceId: 'dev-1',
      observed: { firmware: '8.0.75', haEnabled: true, legacyFlag: 'on' },
      capturedAt: '2026-08-01T00:00:00.000Z',
      dir,
    authority: testLocalWriteAuthority('config_chronicle_state', dir)});
    const second = await recordSnapshot({
      deviceId: 'dev-1',
      observed: { firmware: '8.0.80', haEnabled: true, ntpServer: '10.0.0.1' },
      capturedAt: '2026-08-02T00:00:00.000Z',
      dir,
    authority: testLocalWriteAuthority('config_chronicle_state', dir)});

    expect(second.created).toBe(true);
    expect(second.parentHash).toBe(first.hash);
    expect(second.hash).not.toBe(first.hash);
    expect(second.snapshot.diff).toEqual([
      { key: 'firmware', before: '8.0.75', after: '8.0.80', changeClass: 'changed' },
      { key: 'legacyFlag', before: 'on', after: undefined, changeClass: 'removed' },
      { key: 'ntpServer', before: undefined, after: '10.0.0.1', changeClass: 'added' },
    ]);
    expect(getHead('dev-1', dir)?.hash).toBe(second.hash);
  });

  it('creates no new node for an identical re-record and returns the existing head', async () => {
    const observed = { firmware: '8.0.75', haEnabled: true };
    const first = await recordSnapshot({ deviceId: 'dev-1', observed, capturedAt: '2026-08-01T00:00:00.000Z', dir , authority: testLocalWriteAuthority('config_chronicle_state', dir)});
    const again = await recordSnapshot({ deviceId: 'dev-1', observed, capturedAt: '2026-08-05T00:00:00.000Z', dir , authority: testLocalWriteAuthority('config_chronicle_state', dir)});

    expect(again.created).toBe(false);
    expect(again.hash).toBe(first.hash);
    expect(again.snapshot.capturedAt).toBe('2026-08-01T00:00:00.000Z'); // unchanged head, not re-stamped
    expect(listSnapshots('dev-1', dir)).toHaveLength(1);
  });

  it('creates no new node when only ephemeral keys differ, but they are still stored on the head', async () => {
    const first = await recordSnapshot({
      deviceId: 'dev-1',
      observed: { firmware: '8.0.75', uptimeSeconds: 10, cpuPercent: 3 },
      ephemeralKeys: ['uptimeSeconds', 'cpuPercent'],
      capturedAt: '2026-08-01T00:00:00.000Z',
      dir,
    authority: testLocalWriteAuthority('config_chronicle_state', dir)});
    const again = await recordSnapshot({
      deviceId: 'dev-1',
      observed: { firmware: '8.0.75', uptimeSeconds: 999999, cpuPercent: 87 },
      ephemeralKeys: ['uptimeSeconds', 'cpuPercent'],
      capturedAt: '2026-08-02T00:00:00.000Z',
      dir,
    authority: testLocalWriteAuthority('config_chronicle_state', dir)});

    expect(again.created).toBe(false);
    expect(again.hash).toBe(first.hash);
    expect(listSnapshots('dev-1', dir)).toHaveLength(1);
    expect(first.snapshot.observed.uptimeSeconds).toBe(10);
    expect(first.snapshot.ephemeralKeys).toEqual(['cpuPercent', 'uptimeSeconds']);
    // an ephemeral-only change must never show up as semantic drift
    expect(first.snapshot.diff.map((d) => d.key)).toEqual(['firmware']);
  });

  it('keeps one independent chain per deviceId', async () => {
    const a = await recordSnapshot({ deviceId: 'dev-a', observed: { x: 1 }, capturedAt: '2026-08-01T00:00:00.000Z', dir , authority: testLocalWriteAuthority('config_chronicle_state', dir)});
    const b = await recordSnapshot({ deviceId: 'dev-b', observed: { x: 2 }, capturedAt: '2026-08-01T00:00:00.000Z', dir , authority: testLocalWriteAuthority('config_chronicle_state', dir)});
    await recordSnapshot({ deviceId: 'dev-a', observed: { x: 3 }, capturedAt: '2026-08-02T00:00:00.000Z', dir , authority: testLocalWriteAuthority('config_chronicle_state', dir)});

    expect(getHead('dev-a', dir)?.hash).not.toBe(a.hash);
    expect(getHead('dev-b', dir)?.hash).toBe(b.hash);
    expect(listSnapshots('dev-a', dir)).toHaveLength(2);
    expect(listSnapshots('dev-b', dir)).toHaveLength(1);
    expect(getHead('dev-missing', dir)).toBeUndefined();
    expect(listSnapshots('dev-missing', dir)).toEqual([]);
  });

  it('listSnapshots returns the chain oldest-first with intact parent links', async () => {
    const h1 = (await recordSnapshot({ deviceId: 'dev-1', observed: { x: 1 }, capturedAt: '2026-08-01T00:00:00.000Z', dir , authority: testLocalWriteAuthority('config_chronicle_state', dir)})).hash;
    const h2 = (await recordSnapshot({ deviceId: 'dev-1', observed: { x: 2 }, capturedAt: '2026-08-02T00:00:00.000Z', dir , authority: testLocalWriteAuthority('config_chronicle_state', dir)})).hash;
    const h3 = (await recordSnapshot({ deviceId: 'dev-1', observed: { x: 3 }, capturedAt: '2026-08-03T00:00:00.000Z', dir , authority: testLocalWriteAuthority('config_chronicle_state', dir)})).hash;

    const chain = listSnapshots('dev-1', dir);
    expect(chain.map((s) => s.hash)).toEqual([h1, h2, h3]);
    expect(chain.map((s) => s.parentHash)).toEqual([undefined, h1, h2]);
  });

  it('getDiff returns the stored write-time diff for the head, or between two hashes', async () => {
    const h1 = (await recordSnapshot({ deviceId: 'dev-1', observed: { x: 1, y: 'a' }, capturedAt: '2026-08-01T00:00:00.000Z', dir , authority: testLocalWriteAuthority('config_chronicle_state', dir)})).hash;
    const h2 = (await recordSnapshot({ deviceId: 'dev-1', observed: { x: 2, y: 'a' }, capturedAt: '2026-08-02T00:00:00.000Z', dir , authority: testLocalWriteAuthority('config_chronicle_state', dir)})).hash;
    const h3 = (await recordSnapshot({ deviceId: 'dev-1', observed: { x: 2, y: 'b' }, capturedAt: '2026-08-03T00:00:00.000Z', dir , authority: testLocalWriteAuthority('config_chronicle_state', dir)})).hash;

    expect(getDiff('dev-1', dir, {})).toEqual([
      { key: 'y', before: 'a', after: 'b', changeClass: 'changed' },
    ]);
    expect(getDiff('dev-1', dir, { toHash: h2 })).toEqual([
      { key: 'x', before: 1, after: 2, changeClass: 'changed' },
    ]);
    expect(getDiff('dev-1', dir, { fromHash: h1, toHash: h3 })).toEqual([
      { key: 'x', before: 1, after: 2, changeClass: 'changed' },
      { key: 'y', before: 'a', after: 'b', changeClass: 'changed' },
    ]);
    expect(getDiff('dev-1', dir, { fromHash: h3, toHash: h3 })).toEqual([]);
    expect(() => getDiff('dev-1', dir, { toHash: 'deadbeef' })).toThrow(/deadbeef/);
  });

  it('persists JSON files under the given dir and never touches the repo', async () => {
    await recordSnapshot({ deviceId: 'dev-1', observed: { x: 1 }, capturedAt: '2026-08-01T00:00:00.000Z', dir , authority: testLocalWriteAuthority('config_chronicle_state', dir)});
    const files = readdirSync(dir, { recursive: true }) as string[];
    expect(files.some((f) => String(f).endsWith('.json'))).toBe(true);
    expect(files.every((f) => !String(f).includes('.tmp'))).toBe(true);

    // reload from disk in a fresh call — no in-process cache is holding the chain
    expect(getHead('dev-1', dir)?.observed).toEqual({ x: 1 });
  });

  it('holds a directory lock across the read-modify-write (a pre-held lock blocks the write)', async () => {
    await recordSnapshot({ deviceId: 'dev-1', observed: { x: 1 }, capturedAt: '2026-08-01T00:00:00.000Z', dir , authority: testLocalWriteAuthority('config_chronicle_state', dir)});
    const before = listSnapshots('dev-1', dir).length;

    const lockPath = join(dir, 'dev-1.lock');
    mkdirSync(lockPath, { recursive: true });
    await expect(async () =>
      await recordSnapshot({ deviceId: 'dev-1', observed: { x: 2 }, capturedAt: '2026-08-02T00:00:00.000Z', dir , authority: testLocalWriteAuthority('config_chronicle_state', dir)}),
    ).rejects.toThrow(/LOCK_TIMEOUT/);
    expect(listSnapshots('dev-1', dir)).toHaveLength(before); // nothing partially written

    rmdirSync(lockPath); // release (simulated holder wrote no owner file)
    await recordSnapshot({ deviceId: 'dev-1', observed: { x: 2 }, capturedAt: '2026-08-02T00:00:00.000Z', dir , authority: testLocalWriteAuthority('config_chronicle_state', dir)});
    expect(listSnapshots('dev-1', dir)).toHaveLength(before + 1);
  }, 15_000);

  it('rejects a deviceId that would escape the store directory', async () => {
    await expect(async () =>
      await recordSnapshot({ deviceId: '../escape', observed: { x: 1 }, capturedAt: '2026-08-01T00:00:00.000Z', dir , authority: testLocalWriteAuthority('config_chronicle_state', dir)}),
    ).rejects.toThrow(/deviceId/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('stores canonical JSON on disk so the file content itself is the hashed preimage', async () => {
    const r = await recordSnapshot({
      deviceId: 'dev-1',
      observed: { b: 2, a: 1 },
      capturedAt: '2026-08-01T00:00:00.000Z',
      dir,
    authority: testLocalWriteAuthority('config_chronicle_state', dir)});
    const chainFile = join(dir, 'dev-1.json');
    const parsed = JSON.parse(readFileSync(chainFile, 'utf8')) as {
      deviceId: string;
      headHash: string;
      snapshots: Array<{ hash: string; canonical: string }>;
    };
    expect(parsed.deviceId).toBe('dev-1');
    expect(parsed.headHash).toBe(r.hash);
    expect(parsed.snapshots).toHaveLength(1);
    expect(parsed.snapshots[0].canonical).toBe('{"a":1,"b":2}');
    expect(createHash('sha256').update(parsed.snapshots[0].canonical).digest('hex')).toBe(r.hash);
  });
});
