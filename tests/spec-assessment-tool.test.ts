import { describe, expect, it } from 'vitest';
import { specToolCatalog } from '../apps/mcp-server/src/spec-tool-catalog.js';
const entry = specToolCatalog.find(([name]) => name === 'sangfor_evaluate_config')![1];
const spec = { id: 'assessment', product: 'HCI', items: [{ id: 'ntp', capabilityId: 'time', label: 'NTP', observedKey: 'ntp', op: 'eq', expected: true, severity: 'recommended' }] };
describe('public assessment modes', () => {
  it('defaults to current and refuses a value-only normal verdict', async () => {
    const result = await entry.handler({ spec, observed: { ntp: true } });
    expect(result).toMatchObject({ result: { ok: false, assessment: { mode: 'current' }, summary: { indeterminate: 1 } } });
  });
  it('labels an explicitly requested value comparison', async () => {
    const result = await entry.handler({ spec, observed: { ntp: true }, assessmentMode: 'comparison' });
    expect(result).toMatchObject({ result: { ok: true, assessment: { mode: 'comparison', freshnessRequired: false } } });
  });
  it('requires a valid historical time and rejects overriding the current clock', () => {
    expect(() => entry.handler({ spec, observed: {}, assessmentMode: 'snapshot' })).toThrow('SNAPSHOT_ASSESSMENT_TIME_REQUIRED');
    expect(() => entry.handler({ spec, observed: {}, assessmentMode: 'snapshot', assessmentAt: 'invalid' })).toThrow('SNAPSHOT_ASSESSMENT_TIME_REQUIRED');
    expect(() => entry.handler({ spec, observed: {}, assessmentAt: '2020-01-01T00:00:00Z' })).toThrow('ASSESSMENT_TIME_ONLY_FOR_SNAPSHOT');
    expect(() => entry.handler({ spec, observed: {}, assessmentMode: 'invented' })).toThrow('INVALID_ASSESSMENT_MODE');
  });
});
