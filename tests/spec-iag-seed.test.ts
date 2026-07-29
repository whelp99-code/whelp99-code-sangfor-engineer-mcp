import { describe, expect, it } from 'vitest';
import { evaluateSpec, type IntendedSpec } from '../packages/sangfor-spec/src/index.js';
import iagSpec from '../data/specs/IAG/13.0.120/access-audit.spec.json' with { type: 'json' };
import dashboardSpec from '../data/specs/IAG/13.0.120/dashboard-status.spec.json' with { type: 'json' };

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
      credentialWebAuthEnabled: false, // Open Auth only → context-dependent review
      dot1xEnabled: false,    // recommended fail, environment-dependent → context_dependent
    };
    const r = evaluateSpec(spec, observed);
    expect(r.summary.misconfiguration).toBe(1);
    expect(r.summary.missing).toBe(0);
    expect(r.summary.contextDependent).toBe(2); // strong auth and 802.1X depend on managed-segment context
    expect(r.summary.pass).toBe(1);
    expect(r.ok).toBe(false);
  });

  it('leaves unknown settings INDETERMINATE rather than falsely passing them', () => {
    const r = evaluateSpec(spec, { webAuthEnabled: true }); // others unknown
    expect(r.summary.indeterminate).toBe(3);
    expect(r.ok).toBe(false);
  });

  it('pins the verified manual categories for retention, Web Auth, and 802.1X', () => {
    expect(spec.items.find((item) => item.id === 'log_retention_days')?.label).toMatch(/local advisory baseline/i);
    expect(spec.items.find((item) => item.id === 'log_retention_days')?.source?.page).toContain('category_id=2633335');
    expect(spec.items.find((item) => item.id === 'web_authentication_enabled')?.source?.page).toContain('category_id=2633218');
    expect(spec.items.find((item) => item.id === 'credential_web_auth_for_managed_segments')?.contextDependent).toBe(true);
    expect(spec.items.find((item) => item.id === 'dot1x_access_control')?.source?.page).toContain('category_id=2633214');
    expect(dashboardSpec.items.find((item) => item.id === 'unhandled_security_events_zero')?.source?.page).toContain('category_id=2633271');
    expect(dashboardSpec.items.find((item) => item.id === 'ha_enabled')?.source?.page).toContain('category_id=2633300');
  });
});
