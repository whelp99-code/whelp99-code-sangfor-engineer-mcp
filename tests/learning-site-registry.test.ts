import { describe, expect, it } from 'vitest';
import {
  LEARNING_SITES,
  canonicalizeLearningUrl,
  classifyLearningUrl,
  isUsefulLearningText
} from '../packages/sangfor-collector/src/learning-sites.js';

describe('Sangfor learning site registry', () => {
  it('registers the exact requested roots with source trust', () => {
    expect(LEARNING_SITES.map((site) => site.rootUrl)).toEqual([
      'https://support.sangfor.com/',
      'https://community.sangfor.com/plugin.php?id=info:index'
    ]);
    expect(LEARNING_SITES.map((site) => site.trustLevel)).toEqual(['official', 'internal']);
  });

  it('allows public Support learning pages and rejects private or mutating pages', () => {
    expect(classifyLearningUrl('https://support.sangfor.com/productDocument/read?version_id=2&product_id=1')).toEqual({
      siteId: 'sangfor_support',
      allowed: true
    });
    expect(classifyLearningUrl('https://support.sangfor.com/UserAccount')).toMatchObject({
      siteId: 'sangfor_support',
      allowed: false
    });
    expect(classifyLearningUrl('https://support.sangfor.com/user/logout')).toMatchObject({
      siteId: 'sangfor_support',
      allowed: false
    });
  });

  it('honors Community robots exclusions while allowing forums and public plugins', () => {
    expect(classifyLearningUrl(
      'https://community.sangfor.com/forum.php?mod=viewthread&tid=12230&page=2'
    )).toEqual({ siteId: 'sangfor_community', allowed: true });
    expect(classifyLearningUrl(
      'https://community.sangfor.com/plugin.php?id=info:index'
    )).toEqual({ siteId: 'sangfor_community', allowed: true });
    expect(classifyLearningUrl('https://community.sangfor.com/search.php?q=hci')).toMatchObject({
      siteId: 'sangfor_community',
      allowed: false
    });
    expect(classifyLearningUrl(
      'https://community.sangfor.com/forum.php?mod=attachment&aid=1'
    )).toMatchObject({ siteId: 'sangfor_community', allowed: false });
  });

  it('canonicalizes tracking, fragments, query order, and Discuz redirect noise', () => {
    expect(canonicalizeLearningUrl(
      'https://community.sangfor.com/forum.php?page=2&tid=12230&mod=viewthread&utm_source=x#lastpost'
    )).toBe('https://community.sangfor.com/forum.php?mod=viewthread&page=2&tid=12230');
    expect(canonicalizeLearningUrl(
      'https://support.sangfor.com/productDocument/read?category_id=3&product_id=1&version_id=2#top'
    )).toBe(
      'https://support.sangfor.com/productDocument/read?category_id=3&product_id=1&version_id=2'
    );
  });

  it('rejects login shells and navigation-only text', () => {
    expect(isUsefulLearningText('Login', 'Login')).toBe(false);
    expect(isUsefulLearningText('A system error occurred. Please try again later. '.repeat(8), 'System Error')).toBe(false);
    expect(isUsefulLearningText('Home Products Support Login', 'Support')).toBe(false);
    expect(isUsefulLearningText(
      'Configure the management interface MTU before joining the HCI cluster. '.repeat(6),
      'HCI deployment'
    )).toBe(true);
  });
});
