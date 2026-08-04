import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DirLockTimeoutError, withDirLock, writeFileAtomicSync } from '../packages/shared/src/index.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const mk = () => { const d = mkdtempSync(join(tmpdir(), 'shared-atomic-')); dirs.push(d); return d; };

describe('writeFileAtomicSync', () => {
  it('writes the full content in one atomic step (no partial file, no leftover temp)', () => {
    const dir = mk();
    const target = join(dir, 'nested', 'store.json');
    const payload = JSON.stringify({ hello: 'world', big: 'x'.repeat(50_000) });

    writeFileAtomicSync(target, payload);

    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe(payload);
    // no stray .tmp files left behind in the parent dir
    const leftovers = readdirSync(join(dir, 'nested')).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('never partially overwrites an existing file — a second write fully replaces the first', () => {
    const dir = mk();
    const target = join(dir, 'store.json');
    writeFileAtomicSync(target, 'first-version');
    writeFileAtomicSync(target, 'second-version-longer-than-first');
    expect(readFileSync(target, 'utf8')).toBe('second-version-longer-than-first');
  });

  it('creates parent directories as needed', () => {
    const dir = mk();
    const target = join(dir, 'a', 'b', 'c', 'store.json');
    writeFileAtomicSync(target, 'ok');
    expect(readFileSync(target, 'utf8')).toBe('ok');
  });
});

describe('withDirLock', () => {
  it('runs fn while holding the lock and releases it afterward', () => {
    const dir = mk();
    const lockPath = join(dir, 'store.lock');
    let ranInsideLock = false;
    const result = withDirLock(lockPath, () => {
      ranInsideLock = true;
      expect(existsSync(lockPath)).toBe(true); // lock dir exists while fn runs
      return 42;
    });
    expect(ranInsideLock).toBe(true);
    expect(result).toBe(42);
    expect(existsSync(lockPath)).toBe(false); // released after fn returns
  });

  it('releases the lock even when fn throws', () => {
    const dir = mk();
    const lockPath = join(dir, 'store.lock');
    expect(() => withDirLock(lockPath, () => { throw new Error('boom'); })).toThrow('boom');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('throws a clear DirLockTimeoutError when the lock is already held past the wait budget', () => {
    const dir = mk();
    const lockPath = join(dir, 'store.lock');
    // Simulate a held lock left by another process.
    mkdirSync(lockPath);
    try {
      expect(() => withDirLock(lockPath, () => 'unreachable', { waitMs: 60 })).toThrow(DirLockTimeoutError);
      expect(() => withDirLock(lockPath, () => 'unreachable', { waitMs: 60 })).toThrow(/LOCK_TIMEOUT/);
    } finally {
      rmdirSync(lockPath);
    }
  });

  it('serializes two sequential critical sections against the same lock path', () => {
    const dir = mk();
    const lockPath = join(dir, 'store.lock');
    const order: number[] = [];
    withDirLock(lockPath, () => { order.push(1); });
    withDirLock(lockPath, () => { order.push(2); });
    expect(order).toEqual([1, 2]);
  });

  it('reclaims a stale lock (mtime older than staleLockMs) with a stderr warning, instead of waiting out the timeout', () => {
    const dir = mk();
    const lockPath = join(dir, 'store.lock');
    mkdirSync(lockPath); // simulate an abandoned lock from a crashed holder
    const oldTime = new Date(Date.now() - 60_000); // 60s old
    utimesSync(lockPath, oldTime, oldTime);

    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const result = withDirLock(lockPath, () => 'entered', { waitMs: 200, staleLockMs: 1_000 });
      expect(result).toBe('entered');
      const warned = writeSpy.mock.calls.some(([msg]) => String(msg).includes(`removing stale lock ${lockPath}`));
      expect(warned).toBe(true);
    } finally {
      writeSpy.mockRestore();
    }
    expect(existsSync(lockPath)).toBe(false); // released normally after fn returns
  });

  it('does NOT reclaim a fresh lock — still times out with DirLockTimeoutError', () => {
    const dir = mk();
    const lockPath = join(dir, 'store.lock');
    mkdirSync(lockPath); // fresh mtime (just created)
    try {
      expect(() => withDirLock(lockPath, () => 'unreachable', { waitMs: 100, staleLockMs: 30_000 })).toThrow(DirLockTimeoutError);
      expect(existsSync(lockPath)).toBe(true); // untouched — not reclaimed
    } finally {
      rmdirSync(lockPath);
    }
  });
});
