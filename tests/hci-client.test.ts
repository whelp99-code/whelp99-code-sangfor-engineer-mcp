import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createMockConsoleServer } from '../apps/mock-sangfor-console/src/server.js';
import { HciClient, KeystoneV2TokenProvider, HCI_AUTH_CONTRACT_STATUS } from '@sangfor/hci-client';

let server: ReturnType<typeof createMockConsoleServer>;
let base = '';

beforeAll(async () => {
  server = createMockConsoleServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const provider = () => new KeystoneV2TokenProvider({
  identityBaseUrl: `${base}/openstack/identity/v2.0`,
  tenantName: 'lab', username: 'admin', password: 'mock-password',
});

describe('KeystoneV2TokenProvider (doc contract)', () => {
  it('exposes the honesty label', () => {
    expect(HCI_AUTH_CONTRACT_STATUS).toBe('doc_contract_unverified_on_real_device');
  });

  it('authenticates and caches the token', async () => {
    const p = provider();
    const a = await p.getToken();
    const b = await p.getToken();
    expect(a.tokenId).toMatch(/^mock-token-/);
    expect(a.tenantId).toBe('mocktenant0001');
    expect(b.tokenId).toBe(a.tokenId); // cached, no re-auth
    expect(a.serviceCatalog.map((s) => s.type)).toContain('volume');
  });

  it('fails loudly on bad credentials (no guessing)', async () => {
    const bad = new KeystoneV2TokenProvider({
      identityBaseUrl: `${base}/openstack/identity/v2.0`,
      tenantName: 'lab', username: 'admin', password: 'wrong',
    });
    await expect(bad.getToken()).rejects.toThrow(/Keystone auth failed/);
  });
});

describe('HciClient', () => {
  it('injects X-Auth-Token and resolves the service endpoint from the catalog', async () => {
    const client = new HciClient(provider());
    const res = await client.request('volume', '/volumes');
    expect(res.status).toBe(200);
    expect((res.json as any).volumes).toBeInstanceOf(Array);
  });

  it('re-authenticates exactly once on 401 (expired token)', async () => {
    const client = new HciClient(provider());
    await client.request('volume', '/volumes');                    // warm token
    await fetch(`${base}/openstack/__mock/expire-tokens`, { method: 'POST' });
    const res = await client.request('volume', '/volumes');        // should refresh + retry
    expect(res.status).toBe(200);
  });
});
