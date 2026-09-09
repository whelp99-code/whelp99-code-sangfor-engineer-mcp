import { describe, expect, it } from 'vitest';
import { evaluateSpec, renderAdvisoryReport, type IntendedSpec } from '../packages/sangfor-spec/src/index.js';
import { parseBoundaryEngineerEvaluationCloneV1 } from '../packages/sangfor-engineer-report/src/runtime-boundaries.js';

const NOW = '2026-09-08T00:00:00.000Z';
const source = (overrides: Record<string, unknown> = {}) => ({
  endpoint: 'GET /api/ntp', collectedAt: '2026-09-07T23:59:30.000Z', collectionStatus: 'complete' as const, ...overrides,
});
const spec = (overrides: Partial<IntendedSpec['items'][number]> = {}): IntendedSpec => ({
  id: 'spec.next-actions', product: 'HCI', items: [{
    id: 'ntp.enabled', capabilityId: 'time-sync', label: 'NTP enabled', observedKey: 'ntp.enabled',
    op: 'eq', expected: true, severity: 'must', source: { manual: 'HCI guide' }, maxAgeSec: 300, ...overrides,
  }],
});

describe('evaluateSpec — structured assessment next actions', () => {
  it('keeps a complete fresh PASS action-free and renders assessment evidence metadata', () => {
    const result = evaluateSpec(spec(), { 'ntp.enabled': { value: true, source: source() } }, { mode: 'current', now: NOW });
    expect(result.items[0]).not.toHaveProperty('actionableReason');
    expect(result.items[0]?.nextActions).toBeUndefined();
    expect(result.actionableReasons).toEqual([]);
    expect(result.nextActions).toEqual([]);
    const report = renderAdvisoryReport(spec(), result);
    expect(report).toContain('현재 상태');
    expect(report).toContain(NOW);
    expect(report).toContain('2026-09-07T23:59:30.000Z');
    expect(report).toContain('300초');
  });

  it.each([
    ['missing snapshot assessment time', spec(), { value: true, source: source() }, 'ASSESSMENT_TIME_MISSING', 'SET_ASSESSMENT_TIME'],
    ['missing policy', spec({ maxAgeSec: undefined }), { value: true, source: source() }, 'FRESHNESS_POLICY_MISSING', 'SET_FRESHNESS_POLICY'],
    ['invalid policy', spec({ maxAgeSec: -1 as unknown as number }), { value: true, source: source() }, 'FRESHNESS_POLICY_INVALID', 'SET_FRESHNESS_POLICY'],
    ['expired observation', spec(), { value: true, source: source({ collectedAt: '2026-09-07T23:00:00.000Z' }) }, 'EVIDENCE_EXPIRED', 'RECOLLECT_OBSERVATION'],
    ['missing observation time', spec(), { value: true, source: { collectionStatus: 'complete' } }, 'EVIDENCE_MISSING', 'RECOLLECT_OBSERVATION'],
    ['future observation', spec(), { value: true, source: source({ collectedAt: '2026-09-08T00:00:01.000Z' }) }, 'EVIDENCE_FUTURE', 'RECOLLECT_OBSERVATION'],
    ['incomplete collection', spec(), { value: true, source: source({ collectionStatus: 'partial' }) }, 'COLLECTION_INCOMPLETE', 'COMPLETE_COLLECTION'],
  ] as const)('%s gives an explicit advisory action without changing the verdict contract', (name, input, fact, reasonCode, actionCode) => {
    const options = name === 'missing snapshot assessment time' ? { mode: 'snapshot' as const } : { mode: 'current' as const, now: NOW };
    const result = evaluateSpec(input, { 'ntp.enabled': fact }, options);
    expect(result.items[0]).toMatchObject({ verdict: 'INDETERMINATE', actionableReason: { code: reasonCode }, nextActions: [{ code: actionCode }] });
    expect(result.actionableReasons).toMatchObject([{ code: reasonCode, itemIds: ['ntp.enabled'] }]);
    expect(result.nextActions).toMatchObject([{ code: actionCode, itemIds: ['ntp.enabled'] }]);
  });

  it('identifies absent observed values and senior-review checks without parsing display text', () => {
    const missing = evaluateSpec(spec(), {}, { mode: 'current', now: NOW });
    expect(missing.items[0]).toMatchObject({ actionableReason: { code: 'OBSERVED_VALUE_MISSING' }, nextActions: [{ code: 'OBSERVE_REQUIRED_VALUE' }] });
    const senior = evaluateSpec(spec({ needsSeniorReview: true }), { 'ntp.enabled': { value: true, source: source() } }, { mode: 'current', now: NOW });
    expect(senior.items[0]).toMatchObject({ actionableReason: { code: 'SENIOR_REVIEW_REQUIRED' }, nextActions: [{ code: 'REQUEST_SENIOR_REVIEW' }] });
    const incompatible = evaluateSpec(spec(), { 'ntp.enabled': { value: 'true', source: source() } }, { mode: 'current', now: NOW });
    expect(incompatible.items[0]).toMatchObject({ actionableReason: { code: 'OBSERVED_VALUE_INCOMPATIBLE' }, nextActions: [{ code: 'NORMALIZE_OBSERVED_VALUE' }] });
  });

  it('asks for a usable assessment time when the supplied clock is invalid', () => {
    const result = evaluateSpec(spec(), { 'ntp.enabled': { value: true, source: source() } }, { mode: 'current', now: 'not-a-time' });
    expect(result.items[0]).toMatchObject({
      verdict: 'INDETERMINATE', actionableReason: { code: 'ASSESSMENT_TIME_INVALID' }, nextActions: [{ code: 'SET_ASSESSMENT_TIME' }],
    });
  });

  it('preserves a confirmed FAIL and makes its manual-review follow-up explicit', () => {
    const result = evaluateSpec(spec(), { 'ntp.enabled': { value: false, source: source({ collectionStatus: 'failed', collectedAt: '2020-01-01T00:00:00.000Z' }) } }, { mode: 'current', now: NOW });
    expect(result.items[0]).toMatchObject({ verdict: 'FAIL', actionableReason: { code: 'CONFIRMED_FAIL' }, nextActions: [{ code: 'REVIEW_CONFIRMED_FAIL' }] });
    expect(renderAdvisoryReport(spec(), result)).toContain('REVIEW_CONFIRMED_FAIL');
  });

  it('round-trips structured reasons and actions through the report runtime boundary', () => {
    const result = evaluateSpec(spec(), { 'ntp.enabled': { value: true, source: source({ collectedAt: '2026-09-07T23:00:00.000Z' }) } }, { mode: 'current', now: NOW });
    expect(parseBoundaryEngineerEvaluationCloneV1(JSON.stringify(result))).toEqual(result);
  });
});
