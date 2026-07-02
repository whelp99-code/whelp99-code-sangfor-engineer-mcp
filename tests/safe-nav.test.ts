import { describe, expect, it } from 'vitest';
import { isSafeNavLabel } from '../packages/sangfor-collector/src/safe-nav.js';

describe('safe-nav', () => {
  it('rejects action button labels', () => {
    expect(isSafeNavLabel('Restore Defaults')).toBe(false);
    expect(isSafeNavLabel('Apply to Subgroups')).toBe(false);
    expect(isSafeNavLabel('Save')).toBe(false);
    expect(isSafeNavLabel('Delete')).toBe(false);
    expect(isSafeNavLabel('Enable')).toBe(false);
    expect(isSafeNavLabel('Disable')).toBe(false);
    expect(isSafeNavLabel('Confirm')).toBe(false);
  });

  it('rejects Korean action button labels', () => {
    expect(isSafeNavLabel('저장')).toBe(false);
    expect(isSafeNavLabel('적용')).toBe(false);
    expect(isSafeNavLabel('초기화')).toBe(false);
  });

  it('accepts safe navigation labels', () => {
    expect(isSafeNavLabel('Vulnerabilities')).toBe(true);
    expect(isSafeNavLabel('Malware Scan')).toBe(true);
    expect(isSafeNavLabel('Dashboard')).toBe(true);
    expect(isSafeNavLabel('Security Baseline')).toBe(true);
    expect(isSafeNavLabel('Windows Update')).toBe(true);
    expect(isSafeNavLabel('Endpoint Inventory')).toBe(true);
  });

  it('rejects empty string', () => {
    expect(isSafeNavLabel('')).toBe(false);
    expect(isSafeNavLabel('   ')).toBe(false);
  });

  it('rejects labels longer than 40 characters', () => {
    expect(isSafeNavLabel('a'.repeat(50))).toBe(false);
    expect(isSafeNavLabel('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(false); // 41 chars
  });

  it('accepts labels at the 40-character boundary', () => {
    expect(isSafeNavLabel('a'.repeat(40))).toBe(true);
  });

  it('does not over-block nav labels that merely contain a denylist token as a substring', () => {
    // '사용'(use) must not block '사용자 관리'(User Management); 'ok' must not block Book/Token.
    expect(isSafeNavLabel('사용자 관리')).toBe(true);
    expect(isSafeNavLabel('User Management')).toBe(true);
    expect(isSafeNavLabel('저장소')).toBe(true);   // storage — contains '저장'(save) as substring
    expect(isSafeNavLabel('Bookmarks')).toBe(true); // contains 'ok'
    expect(isSafeNavLabel('Token Settings')).toBe(true);
  });

  it('still blocks single-word action buttons exactly', () => {
    expect(isSafeNavLabel('OK')).toBe(false);
    expect(isSafeNavLabel('확인')).toBe(false);
    expect(isSafeNavLabel('Save Changes')).toBe(false); // 'save' is a whole word
  });
});
