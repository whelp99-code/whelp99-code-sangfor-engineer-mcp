import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('BLRO-ready browser import boundary', () => {
  it('confines browser runtime and CDP implementation to JM layers', () => {
    const result = spawnSync(
      process.execPath,
      ['scripts/check-browser-boundary.mjs'],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    expect(
      `${result.stdout}${result.stderr}`,
      'browser boundary violations',
    ).toContain('BLRO_READY_BROWSER_BOUNDARY_PASS');
    expect(result.status).toBe(0);
  });
});
