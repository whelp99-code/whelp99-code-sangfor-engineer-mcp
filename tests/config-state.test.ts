import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mapEppPoolToConfigState, mapCcPoolToConfigState } from '@sangfor/config-state';

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

describe('mapCcPoolToConfigState', () => {
  it('maps captured CC endpoints to observed facts', () => {
    const ccPool = {
      'POST /apps/secvisual/system/system_manage/get_system_info': {
        system_version: '3.0.98C',
        timezone: 'America/Chicago',
        is_version_expired: false,
        is_cert_expired: false,
        lib_info: { is_virus_lib_exist: true }
      },
      'POST /api/v1/clusters/master': { offline: false },
      'POST /api/v1/clusters/status/mgr': { mode: true },
      'POST /apps/secvisual/link_work_order/Link_work_order/on_config_list': { enable: true, port: 82 },
      'POST /apps/secvisual/alarm/alarm_policy/on_list': [
        { mail_on: true, sms_on: false }
      ],
      'POST /apps/secvisual/home/home/get_report_tag': {
        reports: { generation_type: 'auto' }
      }
    };

    const r = mapCcPoolToConfigState(ccPool, { collectedAt: '2026-07-03T00:00:00Z', collector: 'test' });
    expect(r.observed.systemVersion.value).toBe('3.0.98C');
    expect(r.observed.timezone.value).toBe('America/Chicago');
    expect(r.observed.isVersionExpired.value).toBe(false);
    expect(r.observed.isCertExpired.value).toBe(false);
    expect(r.observed.virusLibExists.value).toBe(true);
    expect(r.observed.clusterMasterOffline.value).toBe(false);
    expect(r.observed.clusterModeEnabled.value).toBe(true);
    expect(r.observed.linkWorkOrderEnabled.value).toBe(true);
    expect(r.observed.linkWorkOrderPort.value).toBe(82);
    expect(r.observed.alarmTuningConfigured.value).toBe(true);
    expect(r.observed.scheduledReportConfigured.value).toBe(true);
    expect(r.observed.alertChannelConfigured.value).toBe(true);
  });
});
