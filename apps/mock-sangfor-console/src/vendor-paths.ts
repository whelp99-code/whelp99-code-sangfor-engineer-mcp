// Vendor-native advisor paths, served in addition to the /api/v1 mock routes so
// the deployed advisor tools (which query real FortiOS REST / Cisco RESTCONF
// paths) can live-sweep this mock console. Shapes mirror the canonical fixtures
// the config-state mappers accept (see tests/mcp-advanced-integration.test.ts).
export const VENDOR_PATH_RESPONSES: Record<string, unknown> = {
  // ── FortiOS: sangfor.advisor_fortios (1) + advisor_fortios_advanced (5) ──
  '/api/v2/firewall/policy': {
    results: [
      { policyid: 1, name: 'Allow-Internal-Traffic', action: 'accept', logtraffic: 'all', 'ssl-ssh-profile': 'certificate-inspection', srcintf: 'port1', dstintf: 'port2' },
      { policyid: 2, name: 'Allow-DNS', action: 'accept', logtraffic: 'utm', srcintf: 'port1', dstintf: 'port2' },
      { policyid: 3, name: 'Deny-All', action: 'deny', logtraffic: 'all', srcintf: 'port3', dstintf: 'port4' },
    ],
  },
  '/api/v2/monitor/system/status': {
    results: [{ cpu: 42, mem: 58, disk: 35, uptime: 864000, version: '7.2.0', serial: 'FG3000D3914908901' }],
  },
  '/api/v2/monitor/system/npu-stats': {
    results: [{ cpu: 65, packets_received: 1500000, packets_dropped: 1200 }],
  },
  '/api/v2/cmdb/system/ha-setting': {
    results: [{ mode: 'a-p', state: 'master', priority: 100, group_id: 1, remote_ip: '192.168.1.2' }],
  },
  '/api/v2/cmdb/firewall/policy': {
    results: [
      { policyid: 1, action: 'accept', srcintf: 'port1', dstintf: 'port2', logtraffic: 'all' },
      { policyid: 2, action: 'accept', srcintf: 'port1', dstintf: 'port2', logtraffic: 'utm' },
      { policyid: 3, action: 'deny', srcintf: 'port3', dstintf: 'port4', logtraffic: 'all' },
    ],
  },
  '/api/v2/cmdb/ips/sensor': {
    results: [{ signature_database: '20250703', sensor_name: 'default' }],
  },
  // ── Cisco IOS-XE: sangfor.advisor_cisco_iosxe (1) + advisor_cisco_iosxe_advanced (7) ──
  '/restconf/data/ietf-interfaces:interfaces': {
    'ietf-interfaces:interface': [
      { name: 'GigabitEthernet0/0/0' },
      { name: 'GigabitEthernet0/0/1' },
      { name: 'Loopback0' },
    ],
  },
  '/restconf/data/Cisco-IOS-XE-utilization:system': {
    'Cisco-IOS-XE-utilization:system': {
      'cpu-utilization': {
        'cpu-core': [
          { 'core-id': 0, 'cpu-utilization': 45 },
          { 'core-id': 1, 'cpu-utilization': 55 },
        ],
      },
    },
  },
  '/restconf/data/Cisco-IOS-XE-memory:memory': {
    'Cisco-IOS-XE-memory:memory': { 'memory-statistics': { total: 1000, used: 500 } },
  },
  '/restconf/data/ietf-interfaces:interfaces-state': {
    'ietf-interfaces:interfaces-state': {
      interface: [
        { name: 'GigabitEthernet0/0/0', 'oper-status': 'up' },
        { name: 'GigabitEthernet0/0/1', 'oper-status': 'down' },
      ],
    },
  },
  '/restconf/data/ietf-routing:routing': {
    'ietf-routing:routing': {
      'control-plane-protocols': {
        'control-plane-protocol': [{ 'vrf-name': 'default' }, { 'vrf-name': 'customer1' }],
      },
    },
  },
  '/restconf/data/Cisco-IOS-XE-zone-based-firewall:zone-pair': {
    'Cisco-IOS-XE-zone-based-firewall:zone-pair': [
      { source_zone: 'inside', destination_zone: 'outside' },
      { source_zone: 'dmz', destination_zone: 'outside' },
    ],
  },
  '/restconf/data/Cisco-IOS-XE-acl:ip': {
    'Cisco-IOS-XE-acl:ip': {
      'access-lists': {
        'access-list': [
          { 'access-list-entries': { 'access-list-entry': [{ sequence: 10, action: 'permit' }, { sequence: 20, action: 'deny' }] } },
          { 'access-list-entries': { 'access-list-entry': [{ sequence: 10, action: 'permit' }] } },
        ],
      },
    },
  },
  '/restconf/data/Cisco-IOS-XE-snort:snort': {
    'Cisco-IOS-XE-snort:snort': { 'snort-config': { 'rule-database-version': '20250703', enabled: true } },
  },
};
