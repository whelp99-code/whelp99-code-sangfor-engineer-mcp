import { describe, expect, it } from 'vitest';
import { recommendSizing } from '../packages/sangfor-sizing/src/index.js';

describe('recommendSizing (advisory tiering, data-driven thresholds)', () => {
  it('classifies IAG by concurrent users using the loaded threshold table', () => {
    const r = recommendSizing('IAG', { concurrentUsers: 8000 });
    // 8000 against [1000,5000,20000] → large (proves thresholds came from data, not lexicographic)
    expect(r.tier).toBe('large');
    expect(r.drivers.some((d) => /user/i.test(d.name))).toBe(true);
  });

  it('cites the threshold source (tierSource) — no ungrounded numbers', () => {
    const r = recommendSizing('IAG', { concurrentUsers: 8000 });
    expect(r.tierSource).not.toBeNull();
    expect(r.tierSource!.label).toBeTruthy();
  });

  it('always marks the result advisory and requires official-guide + SE validation (no fabricated model)', () => {
    const r = recommendSizing('HCI', { vmCount: 200 });
    expect(r.advisory).toBe(true);
    expect(r.disclaimer).toMatch(/Sizing Guide|SE|검증/i);
    expect(r).not.toHaveProperty('exactModel');
  });

  it('returns tier "insufficient_input" when the product is known but no driver is provided', () => {
    const r = recommendSizing('EPP', {});
    expect(r.tier).toBe('insufficient_input');
    expect(r.tierSource).not.toBeNull(); // thresholds exist, only the input is missing
  });

  it('returns "unsourced" (판정불가) for a product with no sourced threshold table — no fabrication', () => {
    const r = recommendSizing('XDR', { eventsPerSecond: 9000 });
    expect(r.tier).toBe('unsourced');
    expect(r.tierSource).toBeNull();
    expect(r.disclaimer).toMatch(/출처 미확정|미확보|판정 불가/);
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
