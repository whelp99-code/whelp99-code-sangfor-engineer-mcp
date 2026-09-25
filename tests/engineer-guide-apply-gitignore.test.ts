import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';

describe('engineer guide-apply artifact ownership', () => {
  it('keeps production dry-run sidecars local-only', () => {
    const result = spawnSync(
      'git',
      ['check-ignore', '-q', 'outputs/engineer-guide-apply/probe.guide-apply.json'],
      { cwd: new URL('..', import.meta.url) },
    );
    expect(result.status).toBe(0);
  });
});
