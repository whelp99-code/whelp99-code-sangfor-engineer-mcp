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
