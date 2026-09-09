import { describe, expect, it } from 'vitest';
import { evaluateSpec, renderAdvisoryReport, type IntendedSpec } from '../packages/sangfor-spec/src/index.js';

/**
 * A1 Freshness SLO (issue #23, design 002 block A1).
 * Iron rule: a declared maxAgeSec may only DEMOTE a would-be PASS to
 * INDETERMINATE (`evidence-expired`). It never upgrades anything, never
 * changes FAIL, and undeclared keys keep their existing behavior.
 */

const NOW = '2026-08-18T12:00:00.000Z';
const FRESH = '2026-08-18T11:59:30.000Z';   // 30s old
const EXPIRED = '2026-08-18T10:00:00.000Z'; // 2h old

function spec(maxAgeSec?: number): IntendedSpec {
  return {
    id: 'spec_freshness',
    product: 'HCI',
    version: '6.11.3',
    items: [{
      id: 'ntp_enabled',
      capabilityId: 'time_sync',
      label: 'NTP enabled',
      observedKey: 'ntp.enabled',
      op: 'eq',
      expected: true,
      severity: 'must',
      source: { manual: 'HCI User Manual', section: 'Time Sync' },
      ...(maxAgeSec !== undefined ? { maxAgeSec } : {})
    }]
  };
}

const fact = (value: unknown, collectedAt?: string) => ({
  value,
  source: { endpoint: 'GET /api/ntp', collector: 'live-xhr', ...(collectedAt ? { collectedAt } : {}) }
});

describe('current and historical evidence contracts', () => {
  const complete = (value: unknown, collectedAt = FRESH) => ({ value, source: { collectedAt, collectionStatus: 'complete' as const } });
  it('requires both item policy and complete collection for a current PASS', () => {
    expect(evaluateSpec(spec(), { 'ntp.enabled': complete(true) }, { mode: 'current', now: NOW }).items[0].reason).toContain('freshness-policy-missing');
    expect(evaluateSpec(spec(300), { 'ntp.enabled': fact(true, FRESH) }, { mode: 'current', now: NOW }).items[0].reason).toContain('collection-unproven');
    const result = evaluateSpec(spec(300), { 'ntp.enabled': complete(true) }, { mode: 'current', now: NOW });
    expect(result.ok).toBe(true);
    expect(result.assessment).toEqual({ mode: 'current', evaluatedAt: NOW, freshnessRequired: true });
  });
  it.each(['partial', 'failed'] as const)('cannot PASS a %s collection', (collectionStatus) => {
    const result = evaluateSpec(spec(300), { 'ntp.enabled': { value: true, source: { collectedAt: FRESH, collectionStatus } } }, { mode: 'current', now: NOW });
    expect(result.ok).toBe(false);
    expect(result.items[0].reason).toContain('collection-incomplete');
  });
  it('rejects future evidence unless an explicit clock tolerance covers it', () => {
    const observed = { 'ntp.enabled': complete(true, '2026-08-18T12:00:01.000Z') };
    expect(evaluateSpec(spec(300), observed, { mode: 'current', now: NOW }).items[0].reason).toContain('evidence-future');
    expect(evaluateSpec(spec(300), observed, { mode: 'current', now: NOW, maxFutureSkewSec: 1 }).ok).toBe(true);
  });
  it('never turns an invalid assessment clock into PASS', () => {
    expect(evaluateSpec(spec(300), { 'ntp.enabled': complete(true) }, { mode: 'current', now: 'invalid' }).items[0].reason).toContain('assessment-time-invalid');
  });
  it('requires an explicit time for a historical snapshot and labels the report', () => {
    const observed = { 'ntp.enabled': complete(true) };
    expect(evaluateSpec(spec(300), observed, { mode: 'snapshot' }).items[0].reason).toContain('assessment-time-missing');
    const result = evaluateSpec(spec(300), observed, { mode: 'snapshot', now: NOW });
    expect(result.ok).toBe(true);
    expect(result.assessment?.mode).toBe('snapshot');
    expect(renderAdvisoryReport(spec(300), result)).toContain(NOW);
  });
  it('preserves a known FAIL even with expired, failed collection', () => {
    const result = evaluateSpec(spec(), { 'ntp.enabled': { value: false, source: { collectedAt: EXPIRED, collectionStatus: 'failed' } } }, { mode: 'current', now: NOW });
    expect(result.items[0].verdict).toBe('FAIL');
  });
  it('labels value comparison and renders indeterminate as 판정 불가', () => {
    const comparison = evaluateSpec(spec(), { 'ntp.enabled': true });
    expect(comparison.assessment?.mode).toBe('comparison');
    expect(renderAdvisoryReport(spec(), comparison)).toContain('최신성 보장 없음');
    const current = evaluateSpec(spec(), { 'ntp.enabled': complete(true) }, { mode: 'current', now: NOW });
    const report = renderAdvisoryReport(spec(), current);
    expect(report).toContain('판정 불가');
    expect(report).toContain('freshness-policy-missing');
  });
});

describe('evaluateSpec — freshness SLO (maxAgeSec)', () => {
  it('keeps PASS when evidence is within the freshness budget', () => {
    const r = evaluateSpec(spec(300), { 'ntp.enabled': fact(true, FRESH) }, { now: NOW });
    expect(r.items[0].verdict).toBe('PASS');
    expect(r.ok).toBe(true);
  });

  it('demotes a would-be PASS on expired evidence to INDETERMINATE with evidence-expired', () => {
    const r = evaluateSpec(spec(300), { 'ntp.enabled': fact(true, EXPIRED) }, { now: NOW });
    expect(r.items[0].verdict).toBe('INDETERMINATE');
    expect(r.items[0].reason).toContain('evidence-expired');
    expect(r.ok).toBe(false);
  });

  it('keeps FAIL as FAIL even when the evidence is expired (never masks negative evidence)', () => {
    const r = evaluateSpec(spec(300), { 'ntp.enabled': fact(false, EXPIRED) }, { now: NOW });
    expect(r.items[0].verdict).toBe('FAIL');
    expect(r.items[0].category).toBe('misconfiguration');
  });

  it('leaves items without maxAgeSec unchanged, however old the evidence is (backward compat)', () => {
    const r = evaluateSpec(spec(undefined), { 'ntp.enabled': fact(true, '2020-01-01T00:00:00.000Z') }, { now: NOW });
    expect(r.items[0].verdict).toBe('PASS');
  });

  it('demotes to INDETERMINATE when maxAgeSec is declared but the fact has no collectedAt (freshness unprovable)', () => {
    const r = evaluateSpec(spec(300), { 'ntp.enabled': fact(true) }, { now: NOW });
    expect(r.items[0].verdict).toBe('INDETERMINATE');
    expect(r.items[0].reason).toContain('evidence-expired');
  });

  it('demotes to INDETERMINATE on an unparseable collectedAt instead of trusting it', () => {
    const r = evaluateSpec(spec(300), { 'ntp.enabled': fact(true, 'not-a-timestamp') }, { now: NOW });
    expect(r.items[0].verdict).toBe('INDETERMINATE');
    expect(r.items[0].reason).toContain('evidence-expired');
  });

  it('defaults evaluation time to wall clock when now is omitted (fresh evidence still passes)', () => {
    const justNow = new Date(Date.now() - 5_000).toISOString();
    const r = evaluateSpec(spec(300), { 'ntp.enabled': fact(true, justNow) });
    expect(r.items[0].verdict).toBe('PASS');
  });

  it('a bare (unwrapped) observed value under a declared maxAgeSec is unprovable — INDETERMINATE', () => {
    const r = evaluateSpec(spec(300), { 'ntp.enabled': true }, { now: NOW });
    expect(r.items[0].verdict).toBe('INDETERMINATE');
    expect(r.items[0].reason).toContain('evidence-expired');
  });
});
