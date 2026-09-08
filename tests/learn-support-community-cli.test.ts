import { describe, expect, it } from 'vitest';
import { supportCommunityCliHelp } from '../scripts/lib/support-community-cli.js';

describe('learn-support-community-sites CLI', () => {
  it('prints help without starting the crawler when --help is passed', () => {
    const output = supportCommunityCliHelp(['--help']);

    expect(output).toContain('Usage: pnpm run learn:sites:full');
    expect(output).toContain('SANGFOR_SUPPORT_MAX_DOCUMENTS');
  });

  it('returns no help for a normal crawl invocation', () => {
    expect(supportCommunityCliHelp([])).toBeUndefined();
  });
});
