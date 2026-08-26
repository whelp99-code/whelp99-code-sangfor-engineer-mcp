import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { explicitLocalPrimaryAuthority, localSafetyMarkerPath } from '../packages/shared/src/index.js';
import { removeLocalSafetyMarker, writeLocalSafetyMarker } from '../packages/sangfor-authority/src/index.js';

const scope = (sourceRoot: string) => ({
  tenantId: 'tenant-a', projectId: 'project-a', actorId: 'actor-a', aggregate: 'evals', sourceRoot,
});

describe('durable local authority safety marker', () => {
  it('survives software restart and fences every explicit local writer independent of environment selectors', async () => {
    const root = mkdtempSync(join(tmpdir(), 'authority-marker-')); const target = join(root, 'evals.jsonl');
    try {
      const first = explicitLocalPrimaryAuthority(scope(root));
      await first.fence.write(first, { operation: 'seed', targetPaths: [target] }, () => writeFileSync(target, 'before\n'));
      writeLocalSafetyMarker({ ...scope(root), epoch: 0, sourceDigest: 'a'.repeat(64), targetDigest: 'a'.repeat(64), highWaterMark: 'hwm', fencedAt: '2026-08-26T00:00:00.000Z' });
      delete process.env.SANGFOR_BLRO_AUTHORITY_STORE;
      const restarted = explicitLocalPrimaryAuthority(scope(root));
      await expect(restarted.fence.write(restarted, { operation: 'late', targetPaths: [target] }, () => writeFileSync(target, 'late\n')))
        .rejects.toThrow('LOCAL_AUTHORITY_WRITE_FENCED');
      expect(readFileSync(target, 'utf8')).toBe('before\n');
      removeLocalSafetyMarker(scope(root));
      await restarted.fence.write(restarted, { operation: 'rollback-write', targetPaths: [target] }, () => writeFileSync(target, 'rollback\n'));
      expect(readFileSync(target, 'utf8')).toBe('rollback\n');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('fails closed when the scoped marker is corrupt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'authority-marker-corrupt-')); const target = join(root, 'evals.jsonl');
    try {
      const authority = explicitLocalPrimaryAuthority(scope(root));
      const marker = localSafetyMarkerPath(authority);
      writeLocalSafetyMarker({ ...scope(root), epoch: 0, sourceDigest: 'a'.repeat(64), targetDigest: 'a'.repeat(64), highWaterMark: 'hwm', fencedAt: '2026-08-26T00:00:00.000Z' });
      writeFileSync(marker, '{broken');
      await expect(authority.fence.write(authority, { operation: 'late', targetPaths: [target] }, () => undefined))
        .rejects.toThrow('LOCAL_AUTHORITY_MARKER_INVALID');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
