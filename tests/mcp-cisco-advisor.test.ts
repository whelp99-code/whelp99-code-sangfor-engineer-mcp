import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// Importing the MCP server module must NOT start the stdio readline loop.
process.env.MCP_NO_SERVE = '1';

describe('MCP sangfor.advisor_cisco_iosxe tool', () => {
  let mockServer: http.Server;
  let base = '';

  beforeAll(async () => {
    // Mock Cisco RESTCONF API — 3 interfaces, 1 of them a loopback.
    mockServer = http.createServer((req, res) => {
      if (req.url === '/restconf/data/ietf-interfaces:interfaces') {
        res.writeHead(200, { 'Content-Type': 'application/yang-data+json' });
        res.end(JSON.stringify({
          'ietf-interfaces:interface': [
            { name: 'GigabitEthernet0/0/0' },
            { name: 'GigabitEthernet0/0/1' },
            { name: 'Loopback0' },
          ],
        }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(mockServer.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => mockServer.close(() => resolve())));

  it('queries the device, maps config-state, and evaluates the Cisco interface baseline end-to-end', async () => {
    const { getToolHandler } = await import('../apps/mcp-server/src/index.js');
    const handler = getToolHandler('sangfor.advisor_cisco_iosxe');
    expect(handler).toBeDefined();

    const result: any = await handler!({ host: base, username: 'admin', password: 'password' });

    expect(result.error).toBeUndefined();
    expect(result.product).toBe('CISCO_IOSXE');
    expect(result.device).toBe(base);
    expect(result.timestamp).toBeTruthy();

    const { evaluation } = result;
    expect(evaluation.items).toBeDefined();
    expect(evaluation.items.length).toBeGreaterThan(0);

    // interface_count observes 'interfaceCount' — 3 interfaces in the mock response.
    const interfaceCountItem = evaluation.items.find((i: any) => i.id === 'interface_count');
    expect(interfaceCountItem).toBeDefined();
    expect(interfaceCountItem.observed).toBe(3);
    expect(interfaceCountItem.verdict).toBe('PASS');

    // loopback_interfaces observes 'loopbackCount' — 1 loopback in the mock response.
    const loopbackItem = evaluation.items.find((i: any) => i.id === 'loopback_interfaces');
    expect(loopbackItem).toBeDefined();
    expect(loopbackItem.observed).toBe(1);
    expect(loopbackItem.verdict).toBe('PASS');
  });

  it('returns a structured error (never throws) when the device is unreachable', async () => {
    const { getToolHandler } = await import('../apps/mcp-server/src/index.js');
    const handler = getToolHandler('sangfor.advisor_cisco_iosxe');

    const result: any = await handler!({ host: 'http://127.0.0.1:1', username: 'admin', password: 'password' });

    expect(result.product).toBe('CISCO_IOSXE');
    expect(result.error).toBeTruthy();
    expect(result.evaluation).toBeUndefined();
  });
});
