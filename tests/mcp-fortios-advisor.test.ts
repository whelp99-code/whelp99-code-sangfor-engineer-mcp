import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// Importing the MCP server module must NOT start the stdio readline loop.
process.env.MCP_NO_SERVE = '1';

describe('MCP sangfor.advisor_fortios tool', () => {
  let mockServer: http.Server;
  let base = '';

  beforeAll(async () => {
    // Mock FortiOS REST API — a fixed 2-policy response with SSL inspection and
    // threat logging both present.
    mockServer = http.createServer((req, res) => {
      if (req.url === '/api/v2/firewall/policy') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          results: [
            { policyid: 1, action: 'accept', logtraffic: 'all' },
            { policyid: 2, action: 'accept', 'ssl-ssh-profile': 'inspection' },
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

  it('queries the device, maps config-state, and evaluates the FortiOS policy baseline end-to-end', async () => {
    const { getToolHandler } = await import('../apps/mcp-server/src/index.js');
    const handler = getToolHandler('sangfor.advisor_fortios');
    expect(handler).toBeDefined();

    const result: any = await handler!({ host: base, username: 'admin', password: 'password' });

    expect(result.error).toBeUndefined();
    expect(result.product).toBe('FORTIOS');
    expect(result.device).toBe(base);
    expect(result.timestamp).toBeTruthy();

    const { evaluation } = result;
    expect(evaluation.items).toBeDefined();
    expect(evaluation.items.length).toBeGreaterThan(0);

    // firewall_policy_count observes 'policyCount' — 2 policies in the mock response.
    const policyCountItem = evaluation.items.find((i: any) => i.id === 'firewall_policy_count');
    expect(policyCountItem).toBeDefined();
    expect(policyCountItem.observed).toBe(2);
    expect(policyCountItem.verdict).toBe('PASS');

    // ssl_inspection_enabled observes 'sslInspectionEnabled' — one policy carries ssl-ssh-profile.
    const sslItem = evaluation.items.find((i: any) => i.id === 'ssl_inspection_enabled');
    expect(sslItem.observed).toBe(true);
    expect(sslItem.verdict).toBe('PASS');

    // threat_logging_enabled observes 'threatLoggingEnabled' — one policy has logtraffic: 'all'.
    const threatLogItem = evaluation.items.find((i: any) => i.id === 'threat_logging_enabled');
    expect(threatLogItem.observed).toBe(true);
    expect(threatLogItem.verdict).toBe('PASS');
  });

  it('returns a structured error (never throws) when the device is unreachable', async () => {
    const { getToolHandler } = await import('../apps/mcp-server/src/index.js');
    const handler = getToolHandler('sangfor.advisor_fortios');

    const result: any = await handler!({ host: 'http://127.0.0.1:1', username: 'admin', password: 'password' });

    expect(result.product).toBe('FORTIOS');
    expect(result.error).toBeTruthy();
    expect(result.evaluation).toBeUndefined();
  });
});
