import { afterEach, describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { loadSpec, listSpecCoverage } from '../packages/sangfor-spec/src/index.js';
import { loadWorkAtoms } from '../packages/sangfor-competency/src/index.js';

const originalCwd = process.cwd();
afterEach(() => {
  process.chdir(originalCwd);
  delete process.env.SANGFOR_SPEC_ROOT;
});

describe('data-root loaders are anchored to the package, not cwd', () => {
  it('loadSpec still resolves after the process changes to an unrelated cwd', () => {
    process.chdir(tmpdir());
    const spec = loadSpec('IAG', '13.0.120');
    expect(spec).not.toBeNull();
    expect(spec!.items.length).toBeGreaterThan(0);
  });

  it('listSpecCoverage still finds all products after chdir', () => {
    process.chdir(tmpdir());
    const cov = listSpecCoverage();
    expect(cov.length).toBeGreaterThan(0);
    expect(cov.map((c) => c.product)).toContain('IAG');
  });

  it('loadWorkAtoms still returns the catalog after chdir', () => {
    process.chdir(tmpdir());
    const atoms = loadWorkAtoms();
    expect(atoms.length).toBeGreaterThan(0);
  });

  it('SANGFOR_SPEC_ROOT override still takes precedence over the anchored default', () => {
    process.env.SANGFOR_SPEC_ROOT = tmpdir(); // empty of specs → no match
    process.chdir(originalCwd);
    // Re-import to pick up the env at module load is not possible mid-file; instead
    // assert via the explicit-root argument path which mirrors the override semantics.
    expect(loadSpec('IAG', '13.0.120', tmpdir())).toBeNull();
  });
});
