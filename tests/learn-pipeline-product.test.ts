import { describe, it, expect } from 'vitest';
import { resolveDocumentProduct } from '../packages/sangfor-collector/src/learn-pipeline.js';

describe('resolveDocumentProduct — no silent HCI misattribution (data integrity)', () => {
  it('returns the product code from a frontmatter header', () => {
    expect(resolveDocumentProduct('product: IAG\ntitle: x\n\nbody')).toBe('IAG');
  });

  it('tolerates surrounding whitespace in the header', () => {
    expect(resolveDocumentProduct('product:   NDR\nmore')).toBe('NDR');
  });

  it('returns null when there is no product header — never fabricates HCI', () => {
    expect(resolveDocumentProduct('title: something\n\nno product line here')).toBeNull();
  });

  it('returns null for empty content', () => {
    expect(resolveDocumentProduct('')).toBeNull();
  });
});
