import { describe, expect, it } from 'vitest';
import { recommendSizing } from '../packages/sangfor-sizing/src/index.js';

describe('recommendSizing (advisory tiering, not authoritative)', () => {
  it('classifies IAG by concurrent users into a tier with drivers', () => {
    const r = recommendSizing('IAG', { concurrentUsers: 8000 });
    expect(['small', 'medium', 'large', 'xlarge']).toContain(r.tier);
    expect(r.drivers.some((d) => /user/i.test(d.name))).toBe(true);
  });

  it('always marks the result advisory and requires official-guide + SE validation (no fabricated model)', () => {
    const r = recommendSizing('HCI', { vmCount: 200 });
    expect(r.advisory).toBe(true);
    expect(r.disclaimer).toMatch(/Sizing Guide|SE|검증/i);
    expect(r).not.toHaveProperty('exactModel');
  });

  it('returns tier "insufficient_input" when no sizing driver is provided', () => {
    const r = recommendSizing('EPP', {});
    expect(r.tier).toBe('insufficient_input');
  });
});

describe('recommendSizing — red-team regressions', () => {
  it('treats negative / zero / Infinity drivers as insufficient_input (no fabricated tier)', () => {
    expect(recommendSizing('IAG', { concurrentUsers: -5 }).tier).toBe('insufficient_input');
    expect(recommendSizing('IAG', { concurrentUsers: 0 }).tier).toBe('insufficient_input');
    expect(recommendSizing('IAG', { concurrentUsers: Infinity as any }).tier).toBe('insufficient_input');
  });
  it('does not throw on non-string product', () => {
    expect(() => recommendSizing(undefined as any, { endpoints: 100 })).not.toThrow();
  });
});
