import type { IncomingMessage, ServerResponse } from 'node:http';

export function ciscoInterfaceHandler(req: IncomingMessage, res: ServerResponse): void {
  // Mock Cisco RESTCONF interface response
  const mockResponse = {
    'ietf-interfaces:interface': [
      {
        name: 'GigabitEthernet0/0/0',
        description: 'WAN Link',
        enabled: true,
        ipv4: { address: [{ ip: '203.0.113.1', netmask: '255.255.255.0' }] },
      },
      {
        name: 'GigabitEthernet0/0/1',
        description: 'LAN Link',
        enabled: true,
        ipv4: { address: [{ ip: '192.168.1.1', netmask: '255.255.255.0' }] },
      },
      {
        name: 'Loopback0',
        description: 'Router ID',
        enabled: true,
        ipv4: { address: [{ ip: '10.0.0.1', netmask: '255.255.255.255' }] },
      },
      {
        name: 'Loopback1',
        enabled: true,
        ipv4: { address: [{ ip: '10.0.0.2', netmask: '255.255.255.255' }] },
      },
    ],
  };

  res.writeHead(200, { 'Content-Type': 'application/yang-data+json' });
  res.end(JSON.stringify(mockResponse));
}

export function ciscoRoutingHandler(req: IncomingMessage, res: ServerResponse): void {
  // Mock Cisco RESTCONF routing response
  const mockResponse = {
    'ietf-routing:routing': {
      'static-routes': {
        static: [
          {
            destination_prefix: '10.10.0.0/16',
            next_hop: { next_hop_address: '203.0.113.254' },
          },
          {
            destination_prefix: '172.16.0.0/12',
            next_hop: { next_hop_address: '203.0.113.254' },
          },
        ],
      },
      'control-plane-protocols': {
        'control-plane-protocol': [
          {
            type: 'ospf',
            name: 'ospf_1',
            ospf: {
              global: { router_id: '10.0.0.1' },
            },
          },
        ],
      },
    },
  };

  res.writeHead(200, { 'Content-Type': 'application/yang-data+json' });
  res.end(JSON.stringify(mockResponse));
}

export function ciscoSystemStatsHandler(req: IncomingMessage, res: ServerResponse): void {
  // Mock /restconf/data/Cisco-IOS-XE-utilization:system response
  const mockSystemStats = {
    'Cisco-IOS-XE-utilization:system': {
      'cpu-utilization': {
        'cpu-core': [
          { 'core-id': 0, 'cpu-utilization': 45 },
          { 'core-id': 1, 'cpu-utilization': 52 },
          { 'core-id': 2, 'cpu-utilization': 38 },
          { 'core-id': 3, 'cpu-utilization': 61 },
        ],
      },
    },
    'Cisco-IOS-XE-memory:memory': {
      'memory-statistics': {
        total: 4294967296,  // 4GB in bytes
        used: 2147483648,   // 2GB in bytes (~50%)
      },
    },
  };
  res.writeHead(200, { 'Content-Type': 'application/yang-data+json' });
  res.end(JSON.stringify(mockSystemStats));
}

export function ciscoZonePolicyHandler(req: IncomingMessage, res: ServerResponse): void {
  // Mock /restconf/data/Cisco-IOS-XE-zone-based-firewall:zone-pair response
  const mockZonePolicies = {
    'Cisco-IOS-XE-zone-based-firewall:zone-pair': [
      {
        source_zone: 'inside',
        destination_zone: 'outside',
        service_policy: 'Inspect_Outside',
      },
      {
        source_zone: 'dmz',
        destination_zone: 'outside',
        service_policy: 'Allow_DMZ_Out',
      },
    ],
  };
  res.writeHead(200, { 'Content-Type': 'application/yang-data+json' });
  res.end(JSON.stringify(mockZonePolicies));
}

export function ciscoSNORTStatusHandler(req: IncomingMessage, res: ServerResponse): void {
  // Mock /restconf/data/Cisco-IOS-XE-snort:snort response
  const mockSNORT = {
    'Cisco-IOS-XE-snort:snort': {
      'snort-config': {
        'rule-database-version': '20250703',
        enabled: true,
        'threat-detection': true,
      },
    },
  };
  res.writeHead(200, { 'Content-Type': 'application/yang-data+json' });
  res.end(JSON.stringify(mockSNORT));
}
