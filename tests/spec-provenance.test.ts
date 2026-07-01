import { describe, expect, it } from 'vitest';
import { evaluateSpec, renderAdvisoryReport, type IntendedSpec } from '../packages/sangfor-spec/src/index.js';

const spec: IntendedSpec = {
  id: 's', product: 'EPP', version: '6.0.4',
  items: [
    { id: 'patch_latest', capabilityId: 'patch', label: 'Patch latest', observedKey: 'patchIsLatest', op: 'eq', expected: true, severity: 'must', source: { manual: 'M' } },
    { id: 'rt_on', capabilityId: 'rt', label: 'Realtime protection', observedKey: 'realtimeOn', op: 'eq', expected: true, severity: 'must', source: { manual: 'M' } },
  ],
};

describe('evaluateSpec — observed coverage / drift (광역 무변경 증명)', () => {
  it('reports spec items with no observed value and observed keys outside the spec', () => {
    const observed = { patchIsLatest: true, unexpectedKey: 'x' }; // realtimeOn missing, unexpectedKey extra
    const r = evaluateSpec(spec, observed);
    expect(r.coverage.specifiedTotal).toBe(2);
    expect(r.coverage.observedTotal).toBe(2);
    expect(r.coverage.unobservedItems).toContain('rt_on');
    expect(r.coverage.unspecifiedKeys).toContain('unexpectedKey');
  });

  it('coverage is informational — does not change ok', () => {
    const clean = evaluateSpec(spec, { patchIsLatest: true, realtimeOn: true });
    expect(clean.ok).toBe(true);
    expect(clean.coverage.unspecifiedKeys).toEqual([]);
    expect(clean.coverage.unobservedItems).toEqual([]);
  });
});

describe('evaluateSpec — observed provenance (ObservedFact wrappers)', () => {
  it('captures source endpoint/collectedAt and renders it, flagging unrecorded provenance', () => {
    const observed = {
      patchIsLatest: { value: true, source: { endpoint: 'POST /api/edrgoweb/v1/patch/statistics', collectedAt: '2026-07-01T00:00:00Z', collector: 'live-xhr' } },
      realtimeOn: true, // bare value → no provenance
    };
    const r = evaluateSpec(spec, observed);
    const patch = r.items.find((i) => i.id === 'patch_latest')!;
    expect(patch.verdict).toBe('PASS'); // wrapper is unwrapped for comparison
    expect(patch.observedSource?.endpoint).toContain('patch/statistics');
    expect(patch.observed).toBe(true); // reports the unwrapped value, not the wrapper

    const md = renderAdvisoryReport(spec, r);
    expect(md).toContain('patch/statistics');
    expect(md).toMatch(/관측 근거 미기록/); // realtimeOn had no source
    // provenance is the collector's CLAIM, not a vendor-verified citation
    expect(md).toMatch(/주장|미검증/);
  });

  it('flags an unknown collector rather than presenting it as trustworthy provenance', () => {
    const observed = {
      patchIsLatest: { value: true, source: { endpoint: '/x', collectedAt: 't', collector: 'totally-made-up' } },
      realtimeOn: true,
    };
    const r = evaluateSpec(spec, observed);
    const md = renderAdvisoryReport(spec, r);
    expect(md).toMatch(/미확인 수집기|unknown collector/i);
  });
});
