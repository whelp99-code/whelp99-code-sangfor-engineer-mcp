import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';

describe('capture artifact ownership', () => {
  it('keeps every final capture bundle local-only', () => {
    const result = spawnSync('git', ['check-ignore', '-q', 'data/captures/probe.enc'], {
      cwd: new URL('..', import.meta.url),
    });
    expect(result.status).toBe(0);
  });
});
