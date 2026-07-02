import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mapEppPoolToConfigState } from '@sangfor/config-state';

const pool = JSON.parse(readFileSync('tests/fixtures/epp-pool.sample.json', 'utf8'));

describe('mapEppPoolToConfigState', () => {
  it('maps captured endpoints to observed facts with XHR provenance', () => {
    const r = mapEppPoolToConfigState(pool, { collectedAt: '2026-07-02T00:00:00Z', collector: 'test' });
    expect(r.observed.patchIsLatest.value).toBe(true);
    expect(r.observed.patchIsLatest.source.endpoint).toBe('POST /api/edrgoweb/v1/patch/statistics');
    expect(r.observed.securityBaselineRuleCount.value).toBe(1);
    expect(r.observed.maliciousDomainDetectionActive.value).toBe(true);
    expect(r.observed.assetInventoryClassifiedCount.value).toBe(5);
  });

  it('omits keys whose endpoint was not captured (never fabricates)', () => {
    const r = mapEppPoolToConfigState(pool);
    expect(r.observed).not.toHaveProperty('darMonitoringActive');   // endpoint not captured
    expect(r.observed).not.toHaveProperty('vulnDefUpdateAvailable');
    expect(r.mappedKeys).not.toContain('darMonitoringActive');
  });
});
