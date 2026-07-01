import { describe, expect, it } from 'vitest';
import { evaluateSpec, type IntendedSpec } from '../packages/sangfor-spec/src/index.js';
import iagSpec from '../data/specs/IAG/13.0.120/access-audit.spec.json' with { type: 'json' };

const spec = iagSpec as IntendedSpec;

describe('IAG 13.0.120 seed spec — end-to-end advisory evaluation', () => {
  it('every spec item carries a real manual citation (anti-hallucination gate)', () => {
    expect(spec.items.length).toBeGreaterThan(0);
    for (const item of spec.items) {
      expect(item.source?.manual).toBeTruthy();
      expect(item.source?.page).toMatch(/support\.sangfor\.com/);
    }
  });

  it('splits a customer config into misconfiguration vs missing vs ok', () => {
    const observed = {
      logRetentionDays: 30,   // below 180 → MUST fail → misconfiguration
      webAuthEnabled: true,   // ok
      dot1xEnabled: false,    // recommended fail → missing
    };
    const r = evaluateSpec(spec, observed);
    expect(r.summary.misconfiguration).toBe(1);
    expect(r.summary.missing).toBe(1);
    expect(r.summary.pass).toBe(1);
    expect(r.ok).toBe(false);
  });

  it('leaves unknown settings INDETERMINATE rather than falsely passing them', () => {
    const r = evaluateSpec(spec, { webAuthEnabled: true }); // others unknown
    expect(r.summary.indeterminate).toBe(2);
    expect(r.ok).toBe(false);
  });
});
