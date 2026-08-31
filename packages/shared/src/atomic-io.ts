import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

function monotonicNowMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

function pauseSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function syncParentDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Atomically replace a file and durably sync both its data and parent directory. */
export function writeFileAtomicSync(filePath: string, data: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(tempPath, 'wx', 0o600);
  try {
    const bytes = Buffer.from(data, 'utf8');
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset, null);
    fsyncSync(fd);
    chmodSync(tempPath, 0o600);
  } finally {
    closeSync(fd);
  }
  renameSync(tempPath, filePath);
  syncParentDirectory(dir);
}

export class DirLockTimeoutError extends Error {
  constructor(lockPath: string, waitMs: number) {
    super(`LOCK_TIMEOUT: could not acquire directory lock at ${lockPath} within ${waitMs}ms`);
    this.name = 'DirLockTimeoutError';
  }
}

/** Run a synchronous critical section while holding an exclusive directory lock. */
export function withDirLock<T>(
  lockPath: string,
  fn: () => T,
  opts: { waitMs?: number; staleLockMs?: number } = {},
): T {
  const waitMs = opts.waitMs ?? 2_000;
  const staleLockMs = opts.staleLockMs ?? 30_000;
  const ownerPath = join(lockPath, 'owner');
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = monotonicNowMs() + waitMs;
  let ownToken: string | undefined;
  for (;;) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      chmodSync(lockPath, 0o700);
      ownToken = `${process.pid}:${randomUUID()}`;
      writeFileSync(ownerPath, ownToken, { mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;

      let ageMs = -1;
      try {
        ageMs = Date.now() - statSync(lockPath).mtimeMs;
      } catch {
        // The lock vanished during contention; retry through the normal wait path.
      }
      if (ageMs >= 0 && ageMs > staleLockMs) {
        try {
          try { unlinkSync(ownerPath); } catch { /* owner file may already be gone */ }
          rmdirSync(lockPath);
          process.stderr.write(`[shared] removing stale lock ${lockPath} (age ${Math.round(ageMs)}ms)\n`);
          continue;
        } catch (reapError) {
          if ((reapError as NodeJS.ErrnoException).code !== 'ENOENT') throw reapError;
        }
      }

      const remaining = deadline - monotonicNowMs();
      if (remaining <= 0) throw new DirLockTimeoutError(lockPath, waitMs);
      pauseSync(Math.min(25, remaining));
    }
  }
  try {
    return fn();
  } finally {
    try {
      let currentOwner: string | undefined;
      try { currentOwner = readFileSync(ownerPath, 'utf8'); } catch { /* missing means taken over */ }
      if (currentOwner !== ownToken) {
        process.stderr.write(`[shared] lock ${lockPath} was taken over — skipping release\n`);
      } else {
        try { unlinkSync(ownerPath); } catch { /* rmdir below remains fail-closed */ }
        rmdirSync(lockPath);
      }
    } catch {
      /* leave a failed lock fail-closed */
    }
  }
}
