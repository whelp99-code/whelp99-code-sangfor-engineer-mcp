import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { localSafetyMarkerPath, localSourceRootIdentity, type LocalWriteScope } from '@sangfor/shared';
import { AuthorityCutoverError } from './errors.js';

export type LocalSafetyMarkerScope = Pick<LocalWriteScope, 'tenantId' | 'projectId' | 'aggregate' | 'sourceRoot' | 'epoch'> & {
  readonly sourceDigest: string;
  readonly targetDigest: string;
  readonly highWaterMark: string;
  readonly fencedAt: string;
};

function syncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function writeLocalSafetyMarker(scope: LocalSafetyMarkerScope): string {
  const marker = localSafetyMarkerPath(scope);
  const directory = dirname(marker);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${marker}.${process.pid}.tmp`;
  const identity = localSourceRootIdentity(scope.sourceRoot);
  const bytes = Buffer.from(`${JSON.stringify({ ...scope, ...identity })}\n`);
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, marker); syncDirectory(directory);
  return marker;
}

export function removeLocalSafetyMarker(scope: Pick<LocalWriteScope, 'tenantId' | 'projectId' | 'aggregate' | 'sourceRoot'>): void {
  const marker = localSafetyMarkerPath(scope);
  if (!existsSync(marker)) return;
  const stat = lstatSync(marker);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new AuthorityCutoverError('LOCAL_AUTHORITY_MARKER_INVALID');
  rmSync(marker); syncDirectory(dirname(marker));
  if (existsSync(marker)) throw new AuthorityCutoverError('LOCAL_AUTHORITY_MARKER_REMOVE_FAILED');
}
