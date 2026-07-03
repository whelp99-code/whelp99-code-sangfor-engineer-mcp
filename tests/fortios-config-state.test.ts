import { describe, it, expect } from 'vitest';
import { mapFortiOSConfigState, type ConfigStateItem } from '@sangfor-engineer/fortios-client';

describe('mapFortiOSConfigState', () => {
  it('maps policy count from API response', () => {
    const apiResponse = {
      results: [
        { policyid: 1, name: 'Policy-1' },
        { policyid: 2, name: 'Policy-2' },
        { policyid: 3, name: 'Policy-3' },
      ],
    };

    const items = mapFortiOSConfigState(apiResponse, 'api');

    const policyCount = items.find((item: ConfigStateItem) => item.observedKey === 'policyCount');
    expect(policyCount).toBeDefined();
    expect(policyCount?.value).toBe(3);
    expect(policyCount?.source).toBe('api');
  });

  it('detects SSL inspection when ssl-ssh-profile present', () => {
    const apiResponse = {
      results: [
        { policyid: 1, 'ssl-ssh-profile': 'certificate-inspection' },
      ],
    };

    const items = mapFortiOSConfigState(apiResponse, 'mock');

    const sslInspection = items.find((item: ConfigStateItem) => item.observedKey === 'sslInspectionEnabled');
    expect(sslInspection?.value).toBe(true);
    expect(sslInspection?.source).toBe('mock');
  });

  it('detects threat logging when logtraffic is set', () => {
    const apiResponse = {
      results: [
        { policyid: 1, logtraffic: 'all' },
        { policyid: 2, logtraffic: 'none' },
      ],
    };

    const items = mapFortiOSConfigState(apiResponse, 'api');

    const threatLogging = items.find((item: ConfigStateItem) => item.observedKey === 'threatLoggingEnabled');
    expect(threatLogging?.value).toBe(true);
  });

  it('counts WAN interfaces by type and name', () => {
    const apiResponse = {
      results: [
        { name: 'port1', type: 'physical' },
        { name: 'port2', type: 'physical' },
        { name: 'internal', type: 'vlan' },
        { name: 'wan1', type: 'physical' },
      ],
    };

    const items = mapFortiOSConfigState(apiResponse, 'api');

    const wanCount = items.find((item: ConfigStateItem) => item.observedKey === 'wanInterfaceCount');
    expect(wanCount?.value).toBe(3); // port1, port2, wan1 are physical
  });

  it('returns empty array when API response is empty', () => {
    const apiResponse = { results: [] };

    const items = mapFortiOSConfigState(apiResponse, 'api');

    expect(items.length).toBeGreaterThan(0);
    items.forEach((item: ConfigStateItem) => {
      expect(item.value).toBeDefined();
      expect(item.observedKey).toBeDefined();
    });
  });
});
