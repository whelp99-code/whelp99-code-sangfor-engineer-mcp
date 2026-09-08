import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, realpathSync, writeSync,
  type BigIntStats,
} from 'node:fs';
import { dirname } from 'node:path';

/**
 * Open flags for a journal append.
 *
 * Deliberately NOT the 'a' shorthand: that implies O_CREAT, so a journal the
 * operator deleted would be silently recreated as an empty file and the
 * at-most-once history would vanish. O_NOFOLLOW additionally refuses a symlink
 * swapped in between the check and the open.
 */
const APPEND_FLAGS = constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW;

export const JOURNAL_REFUSALS = {
  CORRUPT: 'JOURNAL_CORRUPT',
  GENESIS_MISMATCH: 'JOURNAL_GENESIS_MISMATCH',
  HEADER_MISSING: 'JOURNAL_HEADER_MISSING',
  NOT_ESTABLISHED: 'JOURNAL_NOT_ESTABLISHED',
  EMPTY: 'JOURNAL_EMPTY',
  ROOT_INSECURE: 'JOURNAL_ROOT_INSECURE',
  FILE_INSECURE: 'JOURNAL_FILE_INSECURE',
  UNREADABLE: 'JOURNAL_UNREADABLE',
  UNWRITABLE: 'JOURNAL_UNWRITABLE',
  SYNC_FAILED: 'JOURNAL_SYNC_FAILED',
} as const;

export type JournalRefusal = (typeof JOURNAL_REFUSALS)[keyof typeof JOURNAL_REFUSALS];

export class RefusalJournalError extends Error {
  override readonly name = 'RefusalJournalError';
  constructor(readonly reason: JournalRefusal) {
    super(reason);
  }
}

/**
 * Root must be a real, non-symlink directory that this process owns, at mode
 * 0700. Production never creates it: a missing root is NOT_ESTABLISHED.
 */
export function assertSecureRoot(root: string): void {
  const stats = statOrRefuse(root);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new RefusalJournalError(JOURNAL_REFUSALS.ROOT_INSECURE);
  }
  if (realpathSync(root) !== root || (stats.mode & 0o777) !== 0o700
    || stats.uid !== process.getuid?.()) {
    throw new RefusalJournalError(JOURNAL_REFUSALS.ROOT_INSECURE);
  }
}

/** File must already exist as a real, non-symlink regular file at mode 0600. */
export function assertSecureFile(path: string): void {
  const stats = statOrRefuse(path);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new RefusalJournalError(JOURNAL_REFUSALS.FILE_INSECURE);
  }
  if (realpathSync(path) !== path || (stats.mode & 0o777) !== 0o600
    || stats.uid !== process.getuid?.()) {
    throw new RefusalJournalError(JOURNAL_REFUSALS.FILE_INSECURE);
  }
}

function statOrRefuse(path: string) {
  try {
    return lstatSync(path);
  } catch {
    throw new RefusalJournalError(JOURNAL_REFUSALS.NOT_ESTABLISHED);
  }
}

/** Kernel identity for one exact file, including its inode incarnation. */
export type FileIdentity = {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly birthtimeNs: bigint;
};

export function fileIdentity(path: string): FileIdentity {
  const stats = statBigIntOrRefuse(path);
  if (!stableIdentity(stats)) {
    throw new RefusalJournalError(JOURNAL_REFUSALS.FILE_INSECURE);
  }
  return { dev: stats.dev, ino: stats.ino, birthtimeNs: stats.birthtimeNs };
}

function statBigIntOrRefuse(path: string): BigIntStats {
  try {
    return lstatSync(path, { bigint: true });
  } catch {
    throw new RefusalJournalError(JOURNAL_REFUSALS.NOT_ESTABLISHED);
  }
}

function stableIdentity(stats: BigIntStats): boolean {
  return stats.birthtimeNs > 0n;
}

function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.birthtimeNs === right.birthtimeNs;
}

function secureRegularFile(stats: BigIntStats): boolean {
  const uid = process.getuid?.();
  return stats.isFile()
    && (stats.mode & 0o777n) === 0o600n
    && uid !== undefined
    && stats.uid === BigInt(uid)
    && stableIdentity(stats);
}

/**
 * Appends to an ESTABLISHED journal and fsyncs the file and its directory.
 *
 * The window between "we checked the file" and "we wrote to it" is closed by
 * identity, not by hope: lstat before, open without O_CREAT and without
 * following symlinks, fstat the OPEN DESCRIPTOR and require the same
 * device+inode+birth-time plus regular/mode/owner, write, fsync, then lstat the path once
 * more and require the same inode incarnation. If the file is deleted, replaced, or
 * swapped for a symlink at any point, the append refuses and NOTHING is
 * recreated.
 */
export function appendDurably(path: string, line: string, pinned?: FileIdentity): void {
  const before = statBigIntOrRefuse(path);
  if (before.isSymbolicLink() || !secureRegularFile(before)) {
    throw new RefusalJournalError(JOURNAL_REFUSALS.FILE_INSECURE);
  }
  // When the caller pinned an identity at open time, the file must STILL be
  // that exact inode incarnation: delete-and-replace before append is refused.
  if (pinned && !sameFile(pinned, before)) {
    throw new RefusalJournalError(JOURNAL_REFUSALS.FILE_INSECURE);
  }
  let handle: number | undefined;
  try {
    // No O_CREAT: an unlinked journal raises ENOENT instead of reappearing.
    handle = openSync(path, APPEND_FLAGS);
  } catch (error) {
    throw new RefusalJournalError(openRefusal(error));
  }
  try {
    const opened = fstatSync(handle, { bigint: true });
    // The descriptor must be the very file we inspected a moment ago.
    if (!sameFile(before, opened) || !secureRegularFile(opened)) {
      throw new RefusalJournalError(JOURNAL_REFUSALS.FILE_INSECURE);
    }
    writeSync(handle, line);
    fsyncSync(handle);
  } catch (error) {
    throw error instanceof RefusalJournalError
      ? error
      : new RefusalJournalError(JOURNAL_REFUSALS.UNWRITABLE);
  } finally {
    closeSync(handle);
  }
  // A deletion that happened while we were writing still invalidates the append.
  const after = statBigIntOrRefuse(path);
  if (after.isSymbolicLink() || !sameFile(before, after)) {
    throw new RefusalJournalError(JOURNAL_REFUSALS.FILE_INSECURE);
  }
  syncDirectory(dirname(path));
}

function openRefusal(error: unknown): JournalRefusal {
  const code = (error as { readonly code?: string }).code;
  if (code === 'ENOENT') return JOURNAL_REFUSALS.NOT_ESTABLISHED;
  if (code === 'ELOOP' || code === 'EACCES' || code === 'EPERM') {
    return JOURNAL_REFUSALS.FILE_INSECURE;
  }
  return JOURNAL_REFUSALS.UNWRITABLE;
}

function syncDirectory(directoryPath: string): void {
  let directory: number | undefined;
  try {
    directory = openSync(directoryPath, constants.O_RDONLY | constants.O_DIRECTORY);
    fsyncSync(directory);
  } catch {
    throw new RefusalJournalError(JOURNAL_REFUSALS.SYNC_FAILED);
  } finally {
    if (directory !== undefined) closeSync(directory);
  }
}

/**
 * OPERATOR PATH ONLY. Creates the journal exclusively at mode 0600 and fsyncs it
 * plus its directory. Production never calls this; the init CLI and the test
 * fixture initialiser do. Exclusive creation never clobbers an existing journal.
 *
 * This is the ONLY function in the module permitted to create a file, which is
 * why it is defined below appendDurably and asserted separately.
 */
export function createJournalExclusively(path: string): void {
  let handle: number | undefined;
  try {
    handle = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    fsyncSync(handle);
  } catch (error) {
    const code = (error as { readonly code?: string }).code;
    throw new RefusalJournalError(code === 'EEXIST'
      ? JOURNAL_REFUSALS.FILE_INSECURE
      : JOURNAL_REFUSALS.UNWRITABLE);
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
  syncDirectory(dirname(path));
}
