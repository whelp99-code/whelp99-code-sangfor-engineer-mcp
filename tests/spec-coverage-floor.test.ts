import { describe, expect, it } from 'vitest';
import { listSpecCoverage } from '../packages/sangfor-spec/src/index.js';

describe('spec coverage floor', () => {
  // Honest floor: 37 items are grounded in the collected manuals. EPP/HCI/CC
  // additions use `exists` (presence, no invented value) or context_dependent;
  // IAG items keep verified page-URL citations. Reaching 40+ requires page-verified
  // IAG/EPP/CC items, which needs live-manual navigation gated behind M3/M5 — we do
  // NOT fabricate citations to hit a round number.
  it('seeds at least 37 cited spec items across products', () => {
    const total = listSpecCoverage().reduce((sum, c) => sum + c.items, 0);
    expect(total).toBeGreaterThanOrEqual(37);
  });

  it('covers every priority product with at least one spec', () => {
    const products = new Set(listSpecCoverage().map((c) => c.product));
    for (const p of ['EPP', 'IAG', 'HCI', 'CC']) {
      expect([...products].some((x) => x.includes(p) || p.includes(x))).toBe(true);
    }
  });
});
