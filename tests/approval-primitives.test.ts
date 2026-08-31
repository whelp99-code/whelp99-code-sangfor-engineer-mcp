import { testFileLocalWriteAuthority } from './helpers/local-write-authority.js';
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import {
  canonicalizeApprovalPayload, FileSingleUseNonceStore, signDomainApproval,
  verifyDomainApprovalSignature,
} from '@sangfor/approval';
import { FUTURE, runNonceChild } from './helpers/approval-primitives-fixture.js';

const fsFailure = vi.hoisted(() => ({
  fsync: false, fsyncCallToFail: 0, fsyncCalls: 0, rename: false,
  lockErrorCode: null as string | null, lockAttempts: 0,
  renamedTempMode: null as number | null, renamedTempPath: null as string | null,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const fsyncSync = (...args: Parameters<typeof actual.fsyncSync>): void => {
    fsFailure.fsyncCalls += 1;
    if (fsFailure.fsync || fsFailure.fsyncCalls === fsFailure.fsyncCallToFail) throw new Error('simulated fsync failure');
    actual.fsyncSync(...args);
  };
  const mockedMkdirSync = (...args: Parameters<typeof actual.mkdirSync>): ReturnType<typeof actual.mkdirSync> => {
    if (String(args[0]).endsWith('.lock')) {
      fsFailure.lockAttempts += 1;
      if (fsFailure.lockErrorCode) {
        const error = new Error(`simulated lock ${fsFailure.lockErrorCode}`) as NodeJS.ErrnoException;
        error.code = fsFailure.lockErrorCode;
        throw error;
      }
    }
    return actual.mkdirSync(...args);
  };
  const renameSync = (...args: Parameters<typeof actual.renameSync>): void => {
    if (fsFailure.rename) throw new Error('simulated rename failure');
    fsFailure.renamedTempPath = String(args[0]);
    fsFailure.renamedTempMode = actual.statSync(args[0]).mode & 0o777;
    actual.renameSync(...args);
  };
  return { ...actual, fsyncSync, mkdirSync: mockedMkdirSync, renameSync };
});

describe('shared approval primitives', () => {
  it('preserves ordered UTF-8 fields without an extra newline and signs bytes deterministically', async () => {
    const canonical = canonicalizeApprovalPayload(['approved', '한글', 'target']);
    expect(canonical).toBe('approved\n한글\ntarget');
    expect(canonical.endsWith('\n')).toBe(false);
    const signature = signDomainApproval('secret', canonical);
    expect(signature).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(signature).toString('hex')).toBe(
      createHmac('sha256', 'secret').update(canonical, 'utf8').digest('hex'),
    );
    expect(verifyDomainApprovalSignature('secret', canonical, signature)).toEqual({ ok: true });
    expect(verifyDomainApprovalSignature('secret', `${canonical}!`, signature).ok).toBe(false);
    expect(verifyDomainApprovalSignature('secret', canonical, new Uint8Array(4))).toEqual({
      ok: false,
      reason: 'signature length mismatch',
    });
  });

  it('uses a durable lock, atomic 0600 replacement, replay rejection, and corruption fail-closed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'approval-primitive-'));
    try {
      const path = join(dir, 'nonces.json');
      const store = new FileSingleUseNonceStore(path, testFileLocalWriteAuthority('approvals_nonces', path));
      expect((await store.consume('n1', FUTURE)).ok).toBe(true);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(await store.consume('n1', FUTURE)).toMatchObject({ ok: false, reason: expect.stringContaining('already used') });
      writeFileSync(path, '{not-json');
      const corrupt = await store.consume('n2', FUTURE);
      expect(corrupt.ok).toBe(false);
      expect(corrupt.reason).toBeTruthy();
      expect(corrupt.reason).not.toMatch(/already used/u);
      mkdirSync(`${path}.lock`, { mode: 0o700 });
      const started = Date.now();
      const locked = await new FileSingleUseNonceStore(path, testFileLocalWriteAuthority('approvals_nonces', path)).consume('n3', FUTURE);
      expect(Date.now() - started).toBeLessThan(2_300);
      expect(locked).toMatchObject({ ok: false, reason: expect.stringContaining('NONCE_STORE_LOCK_TIMEOUT') });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed on malformed records inside valid JSON and leaves the file unchanged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'approval-malformed-'));
    try {
      const path = join(dir, 'nonces.json');
      const malformedDocs = [
        JSON.stringify({ records: [] }),
        JSON.stringify({ consumed: [], extra: true }),
        JSON.stringify({ consumed: [{ nonce: 'n1', expiresAt: FUTURE }] }),
        JSON.stringify({ consumed: [{ nonce: 'n1', expiresAt: FUTURE, consumedAt: '2026-01-01T00:00:00.000Z', extra: true }] }),
        JSON.stringify({ consumed: [{ nonce: 123, expiresAt: FUTURE, consumedAt: '2026-01-01T00:00:00.000Z' }] }),
        JSON.stringify({ consumed: [{ nonce: 'n1', expiresAt: 'not-a-date', consumedAt: '2026-01-01T00:00:00.000Z' }] }),
        JSON.stringify({ consumed: 'not-an-array' }),
      ];
      for (const doc of malformedDocs) {
        writeFileSync(path, doc);
        const result = await new FileSingleUseNonceStore(path, testFileLocalWriteAuthority('approvals_nonces', path)).consume('n2', FUTURE);
        expect(result.ok).toBe(false);
        expect(result.reason).not.toMatch(/already used/u);
        expect(readFileSync(path, 'utf8')).toBe(doc);
      }
      expect(existsSync(`${path}.lock`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when rename fails and leaves the existing store unchanged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'approval-rename-fail-'));
    try {
      const path = join(dir, 'nonces.json');
      const store = new FileSingleUseNonceStore(path, testFileLocalWriteAuthority('approvals_nonces', path));
      expect((await store.consume('n1', FUTURE)).ok).toBe(true);
      const before = readFileSync(path, 'utf8');
      fsFailure.rename = true;
      try {
        const result = await store.consume('n2', FUTURE);
        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(/simulated rename failure/u);
      } finally {
        fsFailure.rename = false;
      }
      expect(readFileSync(path, 'utf8')).toBe(before);
      expect(existsSync(`${path}.lock`)).toBe(false);
      expect(readdirSync(dir).filter((file) => file.endsWith('.tmp'))).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when fsync fails and leaves the existing store unchanged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'approval-fsync-fail-'));
    try {
      const path = join(dir, 'nonces.json');
      const store = new FileSingleUseNonceStore(path, testFileLocalWriteAuthority('approvals_nonces', path));
      expect((await store.consume('n1', FUTURE)).ok).toBe(true);
      const before = readFileSync(path, 'utf8');
      fsFailure.fsync = true;
      try {
        const result = await store.consume('n2', FUTURE);
        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(/simulated fsync failure/u);
      } finally {
        fsFailure.fsync = false;
      }
      expect(readFileSync(path, 'utf8')).toBe(before);
      expect(existsSync(`${path}.lock`)).toBe(false);
      expect(readdirSync(dir).filter((file) => file.endsWith('.tmp'))).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed on parent-directory fsync failure while retaining the consumed nonce as a replay', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'approval-parent-fsync-'));
    try {
      const path = join(dir, 'nonces.json');
      const store = new FileSingleUseNonceStore(path, testFileLocalWriteAuthority('approvals_nonces', path));
      expect((await store.consume('n1', FUTURE)).ok).toBe(true);
      fsFailure.fsyncCalls = 0;
      fsFailure.fsyncCallToFail = 2;
      try {
        const result = await store.consume('n2', FUTURE);
        expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('simulated fsync failure') });
      } finally {
        fsFailure.fsyncCallToFail = 0;
      }
      const persisted = JSON.parse(readFileSync(path, 'utf8')) as { consumed: Array<{ nonce: string }> };
      expect(persisted.consumed.map((record) => record.nonce)).toEqual(['n1', 'n2']);
      expect(await store.consume('n2', FUTURE)).toMatchObject({
        ok: false,
        reason: expect.stringContaining('approval nonce already used: n2'),
      });
      expect(existsSync(`${path}.lock`)).toBe(false);
    } finally {
      fsFailure.fsyncCallToFail = 0;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses a unique 0600 temp file and does not retry non-EEXIST lock errors', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'approval-lock-error-'));
    try {
      const path = join(dir, 'nonces.json');
      const store = new FileSingleUseNonceStore(path, testFileLocalWriteAuthority('approvals_nonces', path));
      fsFailure.renamedTempMode = null;
      fsFailure.renamedTempPath = null;
      expect(await store.consume('mode-nonce', FUTURE)).toEqual({ ok: true });
      expect(fsFailure.renamedTempMode).toBe(0o600);
      expect(fsFailure.renamedTempPath).toMatch(/nonces\.json\.\d+\.[0-9a-f-]+\.tmp$/u);

      fsFailure.lockAttempts = 0;
      fsFailure.lockErrorCode = 'EACCES';
      try {
        const result = await store.consume('lock-error-nonce', FUTURE);
        expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('simulated lock EACCES') });
        expect(fsFailure.lockAttempts).toBe(1);
      } finally {
        fsFailure.lockErrorCode = null;
      }
    } finally {
      fsFailure.lockErrorCode = null;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows exactly one success when two child processes consume the same nonce', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'approval-race-'));
    try {
      const path = join(dir, 'nonces.json');
      const sourcePath = fileURLToPath(new URL('../packages/sangfor-approval/src/index.ts', import.meta.url));
      const results = await Promise.all([
        await runNonceChild(path, sourcePath, 'same-child-nonce'),
        await runNonceChild(path, sourcePath, 'same-child-nonce'),
      ]);
      const parsed = results.map((result) => JSON.parse(result.output) as { ok: boolean; reason?: string });
      expect(parsed.filter((result) => result.ok)).toHaveLength(1);
      expect(parsed.filter((result) => !result.ok).every((result) => /already used|NONCE_STORE_LOCK_TIMEOUT/u.test(result.reason ?? ''))).toBe(true);
      const finalState = JSON.parse(readFileSync(path, 'utf8')) as { consumed: Array<{ nonce: string }> };
      expect(finalState.consumed).toHaveLength(1);
      expect(finalState.consumed[0].nonce).toBe('same-child-nonce');
      expect(existsSync(`${path}.lock`)).toBe(false);
      expect(readdirSync(dir).filter((file) => file.endsWith('.tmp'))).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists both records when two child processes consume distinct nonces concurrently', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'approval-distinct-'));
    try {
      const path = join(dir, 'nonces.json');
      const sourcePath = fileURLToPath(new URL('../packages/sangfor-approval/src/index.ts', import.meta.url));
      const results = await Promise.all([
        await runNonceChild(path, sourcePath, 'distinct-nonce-a'),
        await runNonceChild(path, sourcePath, 'distinct-nonce-b'),
      ]);
      const parsed = results.map((result) => JSON.parse(result.output) as { ok: boolean; reason?: string });
      expect(parsed.filter((result) => result.ok)).toHaveLength(2);
      const finalState = JSON.parse(readFileSync(path, 'utf8')) as { consumed: Array<{ nonce: string }> };
      expect(finalState.consumed.map((record) => record.nonce).sort()).toEqual(['distinct-nonce-a', 'distinct-nonce-b']);
      expect(existsSync(`${path}.lock`)).toBe(false);
      expect(readdirSync(dir).filter((file) => file.endsWith('.tmp'))).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
