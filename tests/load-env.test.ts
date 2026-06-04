import { describe, expect, it } from 'vitest';
import { parseCollectionLimit } from '../packages/sangfor-collector/src/load-env.js';

describe('load-env', () => {
  it('parseCollectionLimit uses default for empty', () => {
    expect(parseCollectionLimit(undefined, 12)).toBe(12);
    expect(parseCollectionLimit('', 30)).toBe(30);
  });

  it('parseCollectionLimit treats all and zero as unlimited', () => {
    expect(parseCollectionLimit('all', 12)).toBeUndefined();
    expect(parseCollectionLimit('unlimited', 12)).toBeUndefined();
    expect(parseCollectionLimit('0', 12)).toBeUndefined();
    expect(parseCollectionLimit('-1', 12)).toBeUndefined();
  });

  it('parseCollectionLimit parses positive integers', () => {
    expect(parseCollectionLimit('25', 12)).toBe(25);
  });
});
