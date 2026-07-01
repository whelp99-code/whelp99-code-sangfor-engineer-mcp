import { describe, expect, it } from 'vitest';
import { suggestRca } from '../packages/sangfor-rca/src/index.js';

describe('suggestRca', () => {
  it('returns ranked root-cause candidates with concrete check steps for a known symptom', () => {
    const r = suggestRca('EPP agent shows offline on many endpoints', 'EPP');
    expect(r.candidates.length).toBeGreaterThan(0);
    const top = r.candidates[0];
    expect(top.cause).toBeTruthy();
    expect(top.checkSteps.length).toBeGreaterThan(0);
    expect(top.source).toBeTruthy(); // grounded in a manual/wiki reference
  });

  it('filters by product (IAG auth symptom does not surface HCI storage causes)', () => {
    const r = suggestRca('users cannot authenticate, LDAP login failing', 'IAG');
    expect(r.candidates.some((c) => /auth|ldap|radius|bind/i.test(c.cause))).toBe(true);
    expect(r.candidates.every((c) => !/mtu|storage heartbeat/i.test(c.cause))).toBe(true);
  });

  it('returns an empty candidate list (never fabricates) for an unrelated symptom', () => {
    const r = suggestRca('the coffee machine is broken', 'EPP');
    expect(r.candidates.length).toBe(0);
  });
});

describe('suggestRca — red-team regressions (no substring fabrication)', () => {
  it('does NOT fabricate IAG auth causes from "ad" inside unrelated words (upload/download/load)', () => {
    for (const s of ['please upload the dashboard report', 'download the file', 'load balance across nodes', 'ready, headroom is fine']) {
      expect(suggestRca(s, 'IAG').candidates.length).toBe(0);
    }
  });
  it('does NOT fabricate HCI storage causes from "san"/"node" inside unrelated words', () => {
    expect(suggestRca('there are a thousand reasons', 'HCI').candidates.length).toBe(0);
  });
  it('returns empty (never throws) on missing/non-string symptom', () => {
    expect(suggestRca(undefined as any).candidates.length).toBe(0);
    expect(suggestRca('' as any).candidates.length).toBe(0);
  });
});
