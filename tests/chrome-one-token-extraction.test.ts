import { describe, expect, it } from 'vitest';
import { extractTokenByKey } from '../scripts/extract-chrome-one-tokens.js';

const TOKEN = `${'a'.repeat(24)}.${'b'.repeat(24)}.${'c'.repeat(20)}`;

describe('Chrome ONE token extraction', () => {
  it('finds a JWT after Chromium record metadata and separators', () => {
    const binaryText = `noise\x00\x01access_pp_token_https://one.sangfor.com\x08meta\x00${TOKEN}\x00tail`;
    expect(extractTokenByKey(binaryText, 'access_pp_token')).toBe(TOKEN);
  });

  it('returns undefined when a key has no JWT-shaped value', () => {
    expect(extractTokenByKey('\x01access_pp_token_https://one.sangfor.com\x00stale', 'access_pp_token'))
      .toBeUndefined();
  });
});
