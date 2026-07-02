import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createMockConsoleServer } from '../apps/mock-sangfor-console/src/server.js';
import {
  HciClient, KeystoneV2TokenProvider,
  listVolumes, getVolume, createVolume, deleteVolume, collectInventory,
} from '@sangfor/hci-client';

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

describe('hci volumes (read-only + single reversible write primitive)', () => {
  it('lists volumes with parsed fields', async () => {
    const client = mkClient();
    await createVolume(client, { name: 'lv-1', sizeGb: 3 }, 'ct-list-1');
    const vols = await listVolumes(client);
    const found = vols.find((v) => v.name === 'lv-1');
    expect(found).toBeDefined();
    expect(found!.size).toBe(3);
  });

  it('getVolume returns null on 404 (never fabricates)', async () => {
    expect(await getVolume(mkClient(), 'does-not-exist')).toBeNull();
  });

  it('createVolume carries X-Client-Token and returns the parsed creating volume', async () => {
    const { status, volume } = await createVolume(mkClient(), { name: 'cv-1', sizeGb: 2, description: 'd' }, 'ct-cv-1');
    expect(status).toBe(202);
    expect(volume?.status).toBe('creating');
  });

  it('deleteVolume returns the raw status (202 on success, 404 on missing)', async () => {
    const client = mkClient();
    const { volume } = await createVolume(client, { name: 'dv-1', sizeGb: 1 }, 'ct-dv-1');
    expect((await deleteVolume(client, volume!.id)).status).toBe(202);
    expect((await deleteVolume(client, 'missing')).status).toBe(404);
  });

  it('collectInventory is explicitly read-only', async () => {
    const inv = await collectInventory(mkClient());
    expect(inv.readOnly).toBe(true);
    expect(inv.volumes).toBeInstanceOf(Array);
  });
});
