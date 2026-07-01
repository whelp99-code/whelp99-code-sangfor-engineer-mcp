import { describe, expect, it } from 'vitest';
import { evaluateSpec, type IntendedSpec } from '../packages/sangfor-spec/src/index.js';

const baseSpec: IntendedSpec = {
  id: 'spec_iag_1',
  product: 'IAG',
  version: '13.0.120',
  items: [
    {
      id: 'log_retention',
      capabilityId: 'log_validation',
      label: 'Internet access log retention ≥ 365 days',
      observedKey: 'logRetentionDays',
      op: 'gte',
      expected: 365,
      severity: 'must',
      source: { manual: 'SANGFOR IAG v13.0.120 User Manual', section: 'Activity Audit' },
    },
  ],
};

describe('evaluateSpec — false-pass prevention', () => {
  it('returns INDETERMINATE (never PASS) when the observed value is missing', () => {
    const result = evaluateSpec(baseSpec, {}); // no observed value
    expect(result.items[0].verdict).toBe('INDETERMINATE');
    expect(result.summary.indeterminate).toBe(1);
    expect(result.summary.pass).toBe(0);
  });

  it('overall ok is false when nothing was actually verified (all indeterminate)', () => {
    const result = evaluateSpec(baseSpec, {});
    expect(result.ok).toBe(false);
  });
});

describe('evaluateSpec — comparison + classification', () => {
  it('PASS when observed satisfies expected (gte)', () => {
    const result = evaluateSpec(baseSpec, { logRetentionDays: 365 });
    expect(result.items[0].verdict).toBe('PASS');
    expect(result.items[0].category).toBe('ok');
    expect(result.ok).toBe(true);
  });

  it('classifies a failing MUST item as misconfiguration', () => {
    const result = evaluateSpec(baseSpec, { logRetentionDays: 30 });
    expect(result.items[0].verdict).toBe('FAIL');
    expect(result.items[0].category).toBe('misconfiguration');
    expect(result.summary.misconfiguration).toBe(1);
    expect(result.ok).toBe(false);
  });

  it('classifies a failing RECOMMENDED item as missing (not misconfiguration)', () => {
    const spec: IntendedSpec = {
      ...baseSpec,
      items: [{ ...baseSpec.items[0], severity: 'recommended' }],
    };
    const result = evaluateSpec(spec, { logRetentionDays: 30 });
    expect(result.items[0].verdict).toBe('FAIL');
    expect(result.items[0].category).toBe('missing');
    expect(result.summary.missing).toBe(1);
  });

  it('a MUST item without a source citation cannot be asserted — INDETERMINATE + needsSeniorReview', () => {
    const spec: IntendedSpec = {
      ...baseSpec,
      items: [{ ...baseSpec.items[0], source: undefined }],
    };
    const result = evaluateSpec(spec, { logRetentionDays: 30 });
    expect(result.items[0].verdict).toBe('INDETERMINATE');
    expect(result.items[0].reason).toMatch(/source|citation|review/i);
  });
});

describe('evaluateSpec — type-mismatch is INDETERMINATE (never a silent PASS/FAIL)', () => {
  const eqBool: IntendedSpec = {
    ...baseSpec,
    items: [{
      id: 'ha_enabled', capabilityId: 'ha', label: 'HA 활성', observedKey: 'haEnabled',
      op: 'eq', expected: true, severity: 'must',
      source: { manual: 'X' },
    }],
  };

  it('(a) eq boolean expected vs scraped string "true" → INDETERMINATE (not FAIL)', () => {
    const result = evaluateSpec(eqBool, { haEnabled: 'true' });
    expect(result.items[0].verdict).toBe('INDETERMINATE');
    expect(result.items[0].category).toBe('indeterminate');
    expect(result.ok).toBe(false);
  });

  it('eq with genuinely matching boolean still PASSes', () => {
    const result = evaluateSpec(eqBool, { haEnabled: true });
    expect(result.items[0].verdict).toBe('PASS');
    expect(result.ok).toBe(true);
  });

  it('(b) gte 180 vs observed "N/A" → INDETERMINATE (not a fabricated misconfiguration FAIL)', () => {
    const spec: IntendedSpec = {
      ...baseSpec,
      items: [{ ...baseSpec.items[0], expected: 180 }],
    };
    const result = evaluateSpec(spec, { logRetentionDays: 'N/A' });
    expect(result.items[0].verdict).toBe('INDETERMINATE');
    expect(result.summary.misconfiguration).toBe(0);
  });

  it('(c) gte 180 vs observed 200 (real number) → PASS unchanged', () => {
    const spec: IntendedSpec = {
      ...baseSpec,
      items: [{ ...baseSpec.items[0], expected: 180 }],
    };
    const result = evaluateSpec(spec, { logRetentionDays: 200 });
    expect(result.items[0].verdict).toBe('PASS');
  });

  it('gte with numeric string "200" (common scrape shape) still PASSes', () => {
    const spec: IntendedSpec = {
      ...baseSpec,
      items: [{ ...baseSpec.items[0], expected: 180 }],
    };
    const result = evaluateSpec(spec, { logRetentionDays: '200' });
    expect(result.items[0].verdict).toBe('PASS');
  });

  it('(d) includes vs observed {} (object, not string/array) → INDETERMINATE', () => {
    const spec: IntendedSpec = {
      ...baseSpec,
      items: [{
        id: 'x', capabilityId: 'c', label: 'contains', observedKey: 'k',
        op: 'includes', expected: 'foo', severity: 'must', source: { manual: 'X' },
      }],
    };
    const result = evaluateSpec(spec, { k: {} });
    expect(result.items[0].verdict).toBe('INDETERMINATE');
  });

  it('includes still works on a real string', () => {
    const spec: IntendedSpec = {
      ...baseSpec,
      items: [{
        id: 'x', capabilityId: 'c', label: 'contains', observedKey: 'k',
        op: 'includes', expected: 'foo', severity: 'must', source: { manual: 'X' },
      }],
    };
    expect(evaluateSpec(spec, { k: 'a foobar' }).items[0].verdict).toBe('PASS');
    expect(evaluateSpec(spec, { k: 'a barbaz' }).items[0].verdict).toBe('FAIL');
  });

  it('oneOf with a non-array expected → INDETERMINATE (cannot evaluate)', () => {
    const spec: IntendedSpec = {
      ...baseSpec,
      items: [{
        id: 'x', capabilityId: 'c', label: 'mode', observedKey: 'mode',
        op: 'oneOf', expected: 'not-an-array' as unknown, severity: 'must', source: { manual: 'X' },
      }],
    };
    expect(evaluateSpec(spec, { mode: 'a' }).items[0].verdict).toBe('INDETERMINATE');
  });
});

describe('evaluateSpec — needsSeniorReview downgrades an auto-PASS to INDETERMINATE', () => {
  const seniorSpec: IntendedSpec = {
    ...baseSpec,
    items: [{
      ...baseSpec.items[0],
      expected: 180,
      needsSeniorReview: true,
    }],
  };

  it('a passing comparison is NOT auto-PASSed when needsSeniorReview is set', () => {
    const result = evaluateSpec(seniorSpec, { logRetentionDays: 365 });
    expect(result.items[0].verdict).toBe('INDETERMINATE');
    expect(result.items[0].category).toBe('indeterminate');
    expect(result.items[0].reason).toMatch(/시니어|senior/i);
    expect(result.ok).toBe(false);
  });

  it('a failing comparison still FAILs but flags senior review in the reason', () => {
    const result = evaluateSpec(seniorSpec, { logRetentionDays: 30 });
    expect(result.items[0].verdict).toBe('FAIL');
    expect(result.items[0].reason).toMatch(/시니어|senior/i);
  });
});
