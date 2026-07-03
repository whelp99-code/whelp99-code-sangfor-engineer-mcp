import type { IncomingMessage, ServerResponse } from 'node:http';

export function fortiOSPolicyHandler(req: IncomingMessage, res: ServerResponse): void {
  // Mock FortiOS policy response
  const mockPolicies = {
    results: [
      {
        policyid: 1,
        name: 'Allow-Internal-Traffic',
        action: 'accept',
        logtraffic: 'all',
        'ssl-ssh-profile': 'certificate-inspection',
      },
      {
        policyid: 2,
        name: 'Allow-DNS',
        action: 'accept',
        logtraffic: 'utm',
      },
      {
        policyid: 3,
        name: 'Deny-All',
        action: 'deny',
        logtraffic: 'all',
      },
    ],
  };

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(mockPolicies));
}

export function fortiOSInterfaceHandler(req: IncomingMessage, res: ServerResponse): void {
  // Mock FortiOS interface response
  const mockInterfaces = {
    results: [
      { name: 'port1', type: 'physical', ip: '10.0.1.1 255.255.255.0' },
      { name: 'port2', type: 'physical', ip: '192.168.1.1 255.255.255.0' },
      { name: 'port3', type: 'physical', ip: '0.0.0.0 0.0.0.0' },
      { name: 'internal', type: 'vlan', ip: '172.16.0.1 255.255.0.0' },
    ],
  };

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(mockInterfaces));
}

export function fortiOSSystemStatsHandler(req: IncomingMessage, res: ServerResponse): void {
  // Mock /api/v2/monitor/system/status response
  const mockStatus = {
    results: [
      {
        cpu: 42,          // CPU usage %
        mem: 58,          // Memory usage %
        disk: 35,         // Disk usage %
        uptime: 864000,   // Seconds (10 days)
        version: '7.2.0',
        serial: 'FG3000D3914908901',
      },
    ],
  };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(mockStatus));
}

export function fortiOSNPUStatsHandler(req: IncomingMessage, res: ServerResponse): void {
  // Mock /api/v2/monitor/system/npu-stats response
  const mockNPU = {
    results: [
      {
        cpu: 65,   // ASIC CPU usage %
        packets_received: 1500000,
        packets_dropped: 1200,
      },
    ],
  };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(mockNPU));
}

export function fortiOSHASettingHandler(req: IncomingMessage, res: ServerResponse): void {
  // Mock /api/v2/cmdb/system/ha-setting response
  const mockHA = {
    results: [
      {
        mode: 'a-p',               // active-passive
        state: 'master',           // or 'slave', 'standalone'
        priority: 100,
        group_id: 1,
        remote_ip: '192.168.1.2',
      },
    ],
  };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(mockHA));
}

export function fortiOSIPSStatsHandler(req: IncomingMessage, res: ServerResponse): void {
  // Mock /api/v2/monitor/ips/sensor-stat response
  const mockIPSStats = {
    results: [
      {
        sensor_name: 'default',
        signature_database: '20250703',
        packets_detected: 3421,
        packets_blocked: 342,
      },
    ],
  };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(mockIPSStats));
}
