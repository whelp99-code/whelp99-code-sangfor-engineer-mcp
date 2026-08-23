import { describe, expect, it } from 'vitest';
import { normalizeProduct, PRODUCT_PRIORITY, PRODUCTS } from '../packages/shared/src/index.js';

describe('retrieval product normalization', () => {
  it('keeps NGFW, SCC, and HIWARE out of the generic product bucket', () => {
    expect(normalizeProduct('NGFW')).toBe('NGFW');
    expect(normalizeProduct('NGAF')).toBe('NGFW');
    expect(normalizeProduct('Athena NGFW')).toBe('NGFW');
    expect(normalizeProduct('SCC')).toBe('SCC');
    expect(normalizeProduct('Sangfor Data Center Cloud')).toBe('SCC');
    expect(normalizeProduct('HIWARE')).toBe('HIWARE');
    expect(normalizeProduct('HIWARE PSM')).toBe('HIWARE');
  });

  it('keeps the priority list aligned with declared product priorities', () => {
    expect(PRODUCT_PRIORITY).toEqual(
      [...PRODUCTS].sort((left, right) => left.priority - right.priority).map((product) => product.code)
    );
  });
});
