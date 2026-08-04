import { afterEach, describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
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
  it('loadRagIndex(default path) still resolves the real repo index after chdir to an unrelated cwd', () => {
    process.chdir(tmpdir());
    const index = loadRagIndex();
    expect(index.chunks.length).toBeGreaterThan(0);
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
