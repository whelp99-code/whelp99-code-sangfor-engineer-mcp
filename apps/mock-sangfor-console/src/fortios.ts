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
