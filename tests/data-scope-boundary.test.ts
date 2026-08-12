import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * BLRO Phase 3 scope boundary.
 *
 * A data root that is engagement/project-scoped must be resolved through the
 * SCOPED helper by every module that writes it. Today scope is fail-open: when
 * `SANGFOR_ENGAGEMENT_ID` is unset the unscoped helper silently returns the
 * shared root, so a module that forgets the scoped helper does not fail — it
 * writes another project's partition. This gate makes forgetting it a build
 * failure instead, the same way `check-browser-boundary` does for Playwright.
 */

function runGate() {
  return spawnSync(process.execPath, ['scripts/check-data-scope-boundary.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

describe('BLRO data scope boundary', () => {
  it('confines engagement-scoped data roots to the scoped resolver', () => {
    const result = runGate();

    expect(
      `${result.stdout}${result.stderr}`,
      'data scope violations',
    ).toContain('BLRO_DATA_SCOPE_BOUNDARY_PASS');
    expect(result.status).toBe(0);
  });

  it('exits non-zero and names the offending file when a scoped root is resolved unscoped', () => {
    // The gate must be capable of failing. Feed it a file that resolves a
    // scoped root through the unscoped helper and require a named violation.
    const result = spawnSync(
      process.execPath,
      ['scripts/check-data-scope-boundary.mjs', '--self-test'],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    const output = `${result.stdout}${result.stderr}`;
    expect(output, 'self-test must prove the gate can fail').toContain('SELF_TEST_DETECTED_VIOLATION');
    expect(result.status).toBe(0);
  });
});
