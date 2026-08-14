import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('learn-support-community-sites CLI', () => {
  it('prints help without starting the crawler when --help is passed', () => {
    const output = execFileSync('pnpm', ['tsx', 'scripts/learn-support-community-sites.ts', '--help'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 2_000,
      env: {
        ...process.env,
        SANGFOR_SITE_CRAWL_DELAY_MS: '0'
      }
    });

    expect(output).toContain('Usage: pnpm run learn:sites:full');
    expect(output).toContain('SANGFOR_SUPPORT_MAX_DOCUMENTS');
  });
});
