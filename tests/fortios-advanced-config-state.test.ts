import { describe, it, expect } from 'vitest';
import { mapFortiOSSystemHealth, mapFortiOSPolicyAudit } from '@sangfor-engineer/fortios-client';

describe('FortiOS Advanced Config-State Mappers', () => {
  describe('mapFortiOSSystemHealth', () => {
    it('extracts CPU, memory, disk usage from system status', () => {
      const statusResponse = {
        results: [
          {
            cpu: 42,
            mem: 58,
            disk: 35,
          },
        ],
      };
      const npuResponse = { results: [{ cpu: 65 }] };
      const haResponse = { results: [{ mode: 'a-p', state: 'master' }] };

      const items = mapFortiOSSystemHealth(statusResponse, npuResponse, haResponse, 'mock');

      expect(items).toHaveLength(6);
      expect(items.find(i => i.observedKey === 'systemCpuUsage')?.value).toBe(42);
      expect(items.find(i => i.observedKey === 'systemMemoryUsage')?.value).toBe(58);
      expect(items.find(i => i.observedKey === 'systemDiskUsage')?.value).toBe(35);
      expect(items.find(i => i.observedKey === 'npuCpuUsage')?.value).toBe(65);
      expect(items.find(i => i.observedKey === 'haMode')?.value).toBe('active-passive');
      expect(items.find(i => i.observedKey === 'haPrimaryUnit')?.value).toBe(true);
    });
  });

  describe('mapFortiOSPolicyAudit', () => {
    it('validates policy syntax and counts duplicates', () => {
      const policyResponse = {
        results: [
          { action: 'accept', srcintf: 'port1', dstintf: 'port2' },
          { action: 'accept', srcintf: 'port1', dstintf: 'port2' },  // Duplicate
          { action: 'deny', srcintf: 'port3', dstintf: 'port4' },
        ],
      };
      const ipsResponse = {
        results: [{ signature_database: '20250703' }],
      };

      const items = mapFortiOSPolicyAudit(policyResponse, ipsResponse, 'mock');

      expect(items).toHaveLength(3);
      expect(items.find(i => i.observedKey === 'policySyntaxValid')?.value).toBe(true);
      expect(items.find(i => i.observedKey === 'policyDuplicateCount')?.value).toBe(1);
      expect(items.find(i => i.observedKey === 'ipsSignatureVersion')?.value).toBe('20250703');
    });

    it('detects invalid policies (missing required fields)', () => {
      const policyResponse = {
        results: [
          { action: 'accept', srcintf: 'port1' },  // Missing dstintf
          { action: 'deny', dstintf: 'port2' },    // Missing srcintf
        ],
      };
      const ipsResponse = { results: [] };

      const items = mapFortiOSPolicyAudit(policyResponse, ipsResponse, 'mock');

      const syntaxValid = items.find(i => i.observedKey === 'policySyntaxValid')?.value;
      expect(syntaxValid).toBe(false);
    });
  });
});
