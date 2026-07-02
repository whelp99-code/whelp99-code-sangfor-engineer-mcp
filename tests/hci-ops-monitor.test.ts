import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';

process.env.MCP_NO_SERVE = '1';

import { createMockConsoleServer } from '../apps/mock-sangfor-console/src/server.js';
import {
  HciClient, KeystoneV2TokenProvider, createVolume,
  summarizeHciHealth, renderHciHealthReport,
} from '@sangfor/hci-client';

describe('summarizeHciHealth (pure)', () => {
  it('flags error-status volumes and counts by status', () => {
    const s = summarizeHciHealth({
      volumes: [
        { id: 'v1', name: 'a', status: 'available', size: 1, description: null },
        { id: 'v2', name: 'b', status: 'error_deleting', size: 1, description: null },
      ],
      servers: [],
      images: [],
    });
    expect(s.healthy).toBe(false);
    expect(s.errorVolumes).toHaveLength(1);
    expect(s.byStatus.available).toBe(1);
    expect(s.volumeCount).toBe(2);
  });

  it('is healthy and honest when the inventory is empty', () => {
    const s = summarizeHciHealth({ volumes: [], servers: [], images: [] });
    expect(s.healthy).toBe(true);
    expect(s.volumeCount).toBe(0);
    expect(s.findings.some((f) => f.includes('볼륨'))).toBe(true);
  });

  it('renders a Korean read-only report', () => {
    const s = summarizeHciHealth({ volumes: [], servers: [], images: [] });
    const report = renderHciHealthReport(s);
    expect(report).toContain('HCI 운영 점검 리포트');
    expect(report).toContain('read-only');
  });
});

describe('hci_health_report MCP tool (mock integration)', () => {
  let server: ReturnType<typeof createMockConsoleServer>;
  let identityBaseUrl = '';

  beforeAll(async () => {
    server = createMockConsoleServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    identityBaseUrl = `${base}/openstack/identity/v2.0`;
    const client = new HciClient(new KeystoneV2TokenProvider({
      identityBaseUrl, tenantName: 'lab', username: 'admin', password: 'mock-password',
    }));
    await createVolume(client, { name: 'h1', sizeGb: 1 }, 'ct-h1-report');
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('produces a summary + report over the live mock inventory', async () => {
    const mod = await import('../apps/mcp-server/src/index.js');
    const handler = (mod as { getToolHandler: (n: string) => (a: unknown) => Promise<unknown> }).getToolHandler('sangfor.hci_health_report');
    const r = await handler({ identityBaseUrl }) as { summary: { volumeCount: number }; report: string };
    expect(typeof r.summary.volumeCount).toBe('number');
    expect(r.report).toContain('HCI 운영 점검 리포트');
  });
});
