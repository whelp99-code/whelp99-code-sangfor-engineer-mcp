import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isUrlAllowedByRobots,
  parseRobotsDisallowRules,
  resolveSafeCrawlUserDataDir
} from '../packages/sangfor-collector/src/site-learning-crawler.js';

describe('two-site learning crawler access guardrails', () => {
  it('enforces fetched robots disallow rules including wildcards', () => {
    const rules = parseRobotsDisallowRules(`
      User-agent: *
      Disallow: /search.php
      Disallow: /*?mod=attachment*
      Disallow: /member.php$
    `);
    expect(isUrlAllowedByRobots('https://community.sangfor.com/forum.php?mod=viewthread&tid=1', rules))
      .toBe(true);
    expect(isUrlAllowedByRobots('https://community.sangfor.com/search.php?q=hci', rules))
      .toBe(false);
    expect(isUrlAllowedByRobots('https://community.sangfor.com/forum.php?mod=attachment&aid=1', rules))
      .toBe(false);
    expect(isUrlAllowedByRobots('https://community.sangfor.com/member.php', rules)).toBe(false);
  });

  it('allows only explicitly isolated temporary browser profiles', () => {
    const temporaryRoot = resolve(tmpdir());
    // Sibling of the temporary root, so it can never be inside it whatever TMPDIR
    // is set to. Real browser-profile paths are anchored here to prove the refusal
    // without assuming the suite runs under /tmp.
    const outsideTemporaryRoot = `${temporaryRoot}-outside`;
    const isolatedProfile = join(temporaryRoot, 'sangfor-two-site-profile');

    expect(resolveSafeCrawlUserDataDir(undefined)).toBeUndefined();
    expect(resolveSafeCrawlUserDataDir(isolatedProfile)).toBe(isolatedProfile);
    expect(() => resolveSafeCrawlUserDataDir(
      join(outsideTemporaryRoot, 'Users/example/Library/Application Support/Aside')
    )).toThrow('TWO_SITE_PROFILE_NOT_ISOLATED');
    expect(() => resolveSafeCrawlUserDataDir(
      join(outsideTemporaryRoot, 'home/example/.config/google-chrome')
    )).toThrow('TWO_SITE_PROFILE_NOT_ISOLATED');
  });
});
