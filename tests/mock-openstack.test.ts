import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createMockConsoleServer } from '../apps/mock-sangfor-console/src/server.js';

let base = '';
let server: ReturnType<typeof createMockConsoleServer>;

beforeAll(async () => {
  server = createMockConsoleServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const auth = () => fetch(`${base}/openstack/identity/v2.0/tokens`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ auth: { tenantName: 'lab', passwordCredentials: { username: 'admin', password: 'mock-password' } } }),
});

describe('mock openstack: keystone', () => {
  it('issues a token + serviceCatalog for valid credentials', async () => {
    const res = await auth();
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.access.token.id).toMatch(/^mock-token-/);
    expect(body.access.token.tenant.id).toBe('mocktenant0001');
    const types = body.access.serviceCatalog.map((s: any) => s.type);
    expect(types).toEqual(expect.arrayContaining(['identity', 'volume', 'compute', 'image']));
  });

  it('rejects bad credentials with 401', async () => {
    const res = await fetch(`${base}/openstack/identity/v2.0/tokens`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ auth: { tenantName: 'lab', passwordCredentials: { username: 'admin', password: 'wrong' } } }),
    });
    expect(res.status).toBe(401);
  });
});

describe('mock openstack: volumes', () => {
  let token = '';
  let volBase = '';
  beforeAll(async () => {
    const body = await (await auth()).json() as any;
    token = body.access.token.id;
    volBase = body.access.serviceCatalog.find((s: any) => s.type === 'volume').endpoints[0].publicURL
      .replace(/^http:\/\/127\.0\.0\.1:\d+/, base); // catalog carries the default port; rebase to the ephemeral one
  });
  const H = () => ({ 'content-type': 'application/json', 'x-auth-token': token });

  it('requires a valid token (401 otherwise)', async () => {
    const res = await fetch(`${volBase}/volumes`, { headers: { 'x-auth-token': 'nope' } });
    expect(res.status).toBe(401);
  });

  it('creates a volume with 202 → creating → available on subsequent GETs', async () => {
    const create = await fetch(`${volBase}/volumes`, {
      method: 'POST', headers: { ...H(), 'x-client-token': 'ct-1' },
      body: JSON.stringify({ volume: { name: 'vol-a', size: 10, description: 'd' } }),
    });
    expect(create.status).toBe(202);
    const created = (await create.json() as any).volume;
    expect(created.status).toBe('creating');
    const g1 = (await (await fetch(`${volBase}/volumes/${created.id}`, { headers: H() })).json() as any).volume;
    const g2 = (await (await fetch(`${volBase}/volumes/${created.id}`, { headers: H() })).json() as any).volume;
    expect([g1.status, g2.status]).toContain('available');
  });

  it('is idempotent on X-Client-Token (no duplicate volume)', async () => {
    const mk = () => fetch(`${volBase}/volumes`, {
      method: 'POST', headers: { ...H(), 'x-client-token': 'ct-same' },
      body: JSON.stringify({ volume: { name: 'vol-idem', size: 5 } }),
    });
    const a = (await (await mk()).json() as any).volume;
    const b = (await (await mk()).json() as any).volume;
    expect(b.id).toBe(a.id);
    const list = (await (await fetch(`${volBase}/volumes/detail`, { headers: H() })).json() as any).volumes;
    expect(list.filter((v: any) => v.name === 'vol-idem')).toHaveLength(1);
  });

  it('reproduces the documented 202-silent-noop trap under X-Mock-Scenario', async () => {
    const before = (await (await fetch(`${volBase}/volumes/detail`, { headers: H() })).json() as any).volumes.length;
    const res = await fetch(`${volBase}/volumes`, {
      method: 'POST', headers: { ...H(), 'x-client-token': 'ct-noop', 'x-mock-scenario': 'quota-silent-noop' },
      body: JSON.stringify({ volume: { name: 'ghost', size: 999 } }),
    });
    expect(res.status).toBe(202); // lies, like the real device can
    const after = (await (await fetch(`${volBase}/volumes/detail`, { headers: H() })).json() as any).volumes.length;
    expect(after).toBe(before); // nothing was actually created
  });

  it('deletes with 202 and the volume eventually 404s', async () => {
    const created = (await (await fetch(`${volBase}/volumes`, {
      method: 'POST', headers: { ...H(), 'x-client-token': 'ct-del' },
      body: JSON.stringify({ volume: { name: 'vol-del', size: 1 } }),
    })).json() as any).volume;
    const del = await fetch(`${volBase}/volumes/${created.id}`, { method: 'DELETE', headers: H() });
    expect(del.status).toBe(202);
    await fetch(`${volBase}/volumes/${created.id}`, { headers: H() }); // deleting
    await fetch(`${volBase}/volumes/${created.id}`, { headers: H() }); // gone after grace reads
    const last = await fetch(`${volBase}/volumes/${created.id}`, { headers: H() });
    expect(last.status).toBe(404);
  });

  it('expire-tokens helper invalidates issued tokens (drives the client 401-refresh path)', async () => {
    await fetch(`${base}/openstack/__mock/expire-tokens`, { method: 'POST' });
    const res = await fetch(`${volBase}/volumes`, { headers: H() });
    expect(res.status).toBe(401);
  });
});
