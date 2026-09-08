import { testFileLocalWriteAuthority, testLocalWriteAuthority } from './helpers/local-write-authority.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AuditLedger } from '@sangfor/hci-client';

describe('AuditLedger.append — lock-protected hash-chain read-then-append', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ledger-lock-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('append() actually acquires the per-run lock: a pre-held lock blocks it, releasing the lock lets it through', async () => {
    const ledger = new AuditLedger({ dir, secret: 'ledger-secret' , authority: testLocalWriteAuthority('audit', dir)});
    const lockPath = `${ledger.pathFor('run-locked')}.lock`;
    mkdirSync(lockPath); // simulate a held lock (e.g. a concurrent writer)

    await expect(async () => await ledger.append('run-locked', 'request', { op: 'noop' })).rejects.toThrow(/LOCK_TIMEOUT/);
    // no partial/garbage line was written while blocked
    expect(existsSync(ledger.pathFor('run-locked'))).toBe(false);

    rmdirSync(lockPath); // release
    await ledger.append('run-locked', 'request', { op: 'noop' });
    expect(existsSync(lockPath)).toBe(false); // append() releases its own lock afterward
  }, 10_000);

  it('a long sequence of appends produces a fully linked, verifiable hash chain (result integrity under the lock)', async () => {
    const ledger = new AuditLedger({ dir, secret: 's' , authority: testLocalWriteAuthority('audit', dir)});
    for (let i = 0; i < 25; i += 1) {
      await ledger.append('run-seq', i % 2 === 0 ? 'request' : 'response', { i });
    }
    const lines = readFileSync(ledger.pathFor('run-seq'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(25);
    expect(lines.map((l: { seq: number }) => l.seq)).toEqual([...Array(25).keys()]); // no skipped/duplicated seq
    const v = ledger.verify('run-seq');
    expect(v).toEqual({ ok: true, keyed: true });
  });
});
