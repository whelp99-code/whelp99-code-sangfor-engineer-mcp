import { describe, expect, it } from 'vitest';
import { loadSpec, listSpecCoverage } from '../packages/sangfor-spec/src/index.js';

describe('loadSpec', () => {
  it('loads the IAG 13.0.120 seed spec and merges its items', () => {
    const spec = loadSpec('IAG', '13.0.120');
    expect(spec).not.toBeNull();
    expect(spec!.product).toBe('IAG');
    expect(spec!.items.length).toBeGreaterThanOrEqual(3);
    expect(spec!.items.every((i) => i.source?.page)).toBe(true);
  });

  it('normalizes product aliases (SWG/EPP names) to the spec directory', () => {
    const spec = loadSpec('SWG', '13.0.120');
    expect(spec?.product).toBe('IAG');
  });

  it('returns null when no spec exists for the product/version', () => {
    expect(loadSpec('IAG', '99.9.9')).toBeNull();
  });

  it('reports which products/versions have specs (coverage)', () => {
    const cov = listSpecCoverage();
    expect(cov).toContainEqual(expect.objectContaining({ product: 'IAG', version: '13.0.120' }));
  });
});
