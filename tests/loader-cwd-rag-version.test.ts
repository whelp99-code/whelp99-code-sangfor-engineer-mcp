import { afterEach, describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadRagIndex } from '../packages/sangfor-rag/src/index.js';
import { loadVersionRequirements, checkVersionRequirement } from '../packages/sangfor-version/src/index.js';

const originalCwd = process.cwd();
const tmpRoots: string[] = [];
afterEach(() => {
  process.chdir(originalCwd);
  for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('@sangfor/rag and @sangfor/version data roots are anchored to the package, not cwd', () => {
  it('loadRagIndex(default path) ignores a cwd-local decoy index after chdir (repo-anchored, not cwd-relative)', () => {
    // Hermetic anchoring proof: the real repo index is a gitignored runtime
    // artifact (absent in CI), so instead of asserting on its contents, plant a
    // decoy at <cwd>/data/rag/index.json — a cwd-relative loader would pick it
    // up, the anchored loader must never see it.
    const decoyRoot = mkdtempSync(join(tmpdir(), 'sangfor-decoy-cwd-'));
    tmpRoots.push(decoyRoot);
    mkdirSync(join(decoyRoot, 'data', 'rag'), { recursive: true });
    writeFileSync(
      join(decoyRoot, 'data', 'rag', 'index.json'),
      JSON.stringify({ version: 1, chunks: [{ id: 'decoy-chunk', title: 'decoy', text: 'decoy', vector: [1], sourceType: 'internal', product: 'HCI', trustLevel: 'internal' }], updatedAt: new Date().toISOString() }),
    );
    process.chdir(decoyRoot);
    const index = loadRagIndex();
    expect(index.chunks.some((c) => c.id === 'decoy-chunk')).toBe(false);
  });

  it('loadVersionRequirements(default root) still returns the real catalog after chdir', () => {
    process.chdir(tmpdir());
    const reqs = loadVersionRequirements();
    expect(reqs.length).toBeGreaterThan(0);
  });

  it('checkVersionRequirement (default root) still finds a known device after chdir', () => {
    process.chdir(tmpdir());
    const check = checkVersionRequirement('Athena NDR', '3.0.98');
    expect(check).not.toBeNull();
  });

  it('SANGFOR_VERSION_ROOT override still takes precedence over the anchored default', () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), 'sangfor-empty-version-'));
    tmpRoots.push(emptyRoot);
    process.chdir(tmpdir());
    expect(loadVersionRequirements(emptyRoot)).toEqual([]);
  });
});
