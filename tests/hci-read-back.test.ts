import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createMockConsoleServer } from '../apps/mock-sangfor-console/src/server.js';
import { HciClient, KeystoneV2TokenProvider, createVolume, readBackVolume } from '@sangfor/hci-client';

let server: ReturnType<typeof createMockConsoleServer>;
let base = '';

beforeAll(async () => {
  server = createMockConsoleServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const mkClient = () => new HciClient(new KeystoneV2TokenProvider({
  identityBaseUrl: `${base}/openstack/identity/v2.0`,
  tenantName: 'lab', username: 'admin', password: 'mock-password',
}));
const fast = { pollIntervalMs: 1, maxPolls: 5 };

describe('readBackVolume — the only success oracle', () => {
  it('PASSes when the created volume reaches available with matching name/size', async () => {
    const client = mkClient();
    const { volume } = await createVolume(client, { name: 'rb-ok', sizeGb: 7 }, 'ct-rb-ok');
    const rb = await readBackVolume(client, { volumeId: volume!.id, name: 'rb-ok', sizeGb: 7 }, fast);
    expect(rb.verdict).toBe('PASS');
  });

  it('FAILs on the documented 202-silent-noop trap (202 alone is never success)', async () => {
    const client = mkClient();
    const rb = await readBackVolume(client, { volumeId: 'ghost-never-created', name: 'ghost', sizeGb: 999 }, fast);
    expect(rb.verdict).toBe('FAIL');
    expect(rb.reason).toMatch(/not found/);
  });

  it('FAILs on a size mismatch', async () => {
    const client = mkClient();
    const { volume } = await createVolume(client, { name: 'rb-size', sizeGb: 2 }, 'ct-rb-size');
    const rb = await readBackVolume(client, { volumeId: volume!.id, name: 'rb-size', sizeGb: 3 }, fast);
    expect(rb.verdict).toBe('FAIL');
  });

  it('is INDETERMINATE when the name matches more than one volume (never PASS)', async () => {
    const client = mkClient();
    await createVolume(client, { name: 'dup', sizeGb: 1 }, 'ct-dup-1');
    await createVolume(client, { name: 'dup', sizeGb: 1 }, 'ct-dup-2');
    const rb = await readBackVolume(client, { name: 'dup', sizeGb: 1 }, fast);
    expect(rb.verdict).toBe('INDETERMINATE');
  });
});
