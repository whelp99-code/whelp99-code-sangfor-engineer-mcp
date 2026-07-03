import { describe, it, expect } from 'vitest';
import { mapCiscoSystemHealth, mapCiscoPolicyAudit } from '@sangfor-engineer/cisco-client';

describe('Cisco Advanced Config-State Mappers', () => {
  describe('mapCiscoSystemHealth', () => {
    it('calculates average CPU from per-core data', () => {
      const cpuResponse = {
        'Cisco-IOS-XE-utilization:system': {
          'cpu-utilization': {
            'cpu-core': [
              { 'core-id': 0, 'cpu-utilization': 40 },
              { 'core-id': 1, 'cpu-utilization': 60 },
            ],
          },
        },
      };
      const memoryResponse = {
        'Cisco-IOS-XE-memory:memory': {
          'memory-statistics': {
            total: 1000,
            used: 500,
          },
        },
      };
      const interfacesResponse = {
        'ietf-interfaces:interfaces-state': {
          interface: [
            { name: 'GigabitEthernet0/0/0', 'oper-status': 'up' },
            { name: 'GigabitEthernet0/0/1', 'oper-status': 'down' },
          ],
        },
      };
      const vrfResponse = {
        'ietf-routing:routing': {
          'control-plane-protocols': {
            'control-plane-protocol': [
              { 'vrf-name': 'default' },
              { 'vrf-name': 'customer1' },
              { 'vrf-name': 'customer1' },  // Duplicate, should count as 1
            ],
          },
        },
      };

      const items = mapCiscoSystemHealth(cpuResponse, memoryResponse, interfacesResponse, vrfResponse, 'mock');

      expect(items).toHaveLength(4);
      expect(items.find(i => i.observedKey === 'systemCpuUsageAverage')?.value).toBe(50);  // (40+60)/2
      expect(items.find(i => i.observedKey === 'systemMemoryUsage')?.value).toBe(50);      // (500/1000)*100
      expect(items.find(i => i.observedKey === 'interfaceDownCount')?.value).toBe(1);
      expect(items.find(i => i.observedKey === 'vrfCount')?.value).toBe(2);                 // default + customer1
    });
  });

  describe('mapCiscoPolicyAudit', () => {
    it('counts zone-pair policies and ACL rules', () => {
      const zonePolicyResponse = {
        'Cisco-IOS-XE-zone-based-firewall:zone-pair': [
          { source_zone: 'inside', destination_zone: 'outside' },
          { source_zone: 'dmz', destination_zone: 'outside' },
        ],
      };
      const aclResponse = {
        'Cisco-IOS-XE-acl:ip': {
          'access-lists': {
            'access-list': [
              {
                'access-list-entries': {
                  'access-list-entry': [
                    { sequence: 10, action: 'permit' },
                    { sequence: 20, action: 'deny' },
                  ],
                },
              },
              {
                'access-list-entries': {
                  'access-list-entry': [
                    { sequence: 10, action: 'permit' },
                  ],
                },
              },
            ],
          },
        },
      };
      const snortResponse = {
        'Cisco-IOS-XE-snort:snort': {
          'snort-config': {
            'rule-database-version': '20250703',
            enabled: true,
          },
        },
      };

      const items = mapCiscoPolicyAudit(zonePolicyResponse, aclResponse, snortResponse, 'mock');

      expect(items).toHaveLength(4);
      expect(items.find(i => i.observedKey === 'zonePairPolicyCount')?.value).toBe(2);
      expect(items.find(i => i.observedKey === 'aclRuleCount')?.value).toBe(3);  // 2 + 1
      expect(items.find(i => i.observedKey === 'snortSignatureVersion')?.value).toBe('20250703');
      expect(items.find(i => i.observedKey === 'snortInspectionEnabled')?.value).toBe(true);
    });
  });
});
