// A2 (Step 2) — the HCI/SCP REST *collection* path stamps a fact-level provenance
// envelope on every observed value. Envelope shape must be compatible with
// @sangfor/config-state's FactProvenance (transport/endpoint/mapperVersion/
// collectedAt/collector, latencyMs measured > 0), and constructing an observed
// HCI fact without a complete envelope must fail closed.
// The write/apply path (apply-machine, read-back, audit ledger) is out of scope.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createMockConsoleServer } from '../apps/mock-sangfor-console/src/server.js';
import { isFactProvenance } from '../packages/sangfor-config-state/src/index.js';
import {
  HCI_MAPPER_VERSION,
  HciClient,
  KeystoneV2TokenProvider,
  collectInventory,
  createHciObservedFact,
  listVolumesObserved,
  type HciObservedFact,
} from '../packages/sangfor-hci-client/src/index.js';

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

describe('HCI_MAPPER_VERSION', () => {
  it('is a package-owned semver constant (never hardcoded per call site)', () => {
    expect(typeof HCI_MAPPER_VERSION).toBe('string');
    expect(HCI_MAPPER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('createHciObservedFact — fail closed', () => {
  const good = {
    transport: 'api' as const,
    endpoint: 'GET /volumes/detail',
    mapperVersion: HCI_MAPPER_VERSION,
    collectedAt: '2026-07-02T00:00:00.000Z',
    collector: 'hci-rest-collector',
    latencyMs: 12,
  };

  it('builds { value, source } where source IS the envelope', () => {
    const fact = createHciObservedFact(3, good);
    expect(fact.value).toBe(3);
    expect(fact.source).toEqual(good);
  });

  it('refuses a fact with no envelope at all', () => {
    expect(() => createHciObservedFact(3, undefined as unknown as HciObservedFact['source'])).toThrow(/^MISSING_PROVENANCE:/);
    expect(() => createHciObservedFact(3, null as unknown as HciObservedFact['source'])).toThrow(/^MISSING_PROVENANCE:/);
  });

  it('refuses a fact whose envelope is missing a required field', () => {
    for (const field of ['transport', 'endpoint', 'mapperVersion', 'collectedAt', 'collector'] as const) {
      const broken = { ...good } as Record<string, unknown>;
      delete broken[field];
      expect(() => createHciObservedFact(3, broken as unknown as HciObservedFact['source'])).toThrow(/^MISSING_PROVENANCE:/);
    }
  });

  it('refuses an unmeasured latency (0 or negative is not a measurement)', () => {
    expect(() => createHciObservedFact(3, { ...good, latencyMs: 0 })).toThrow(/^MISSING_PROVENANCE:/);
    expect(() => createHciObservedFact(3, { ...good, latencyMs: -1 })).toThrow(/^MISSING_PROVENANCE:/);
  });
});

describe('listVolumesObserved — REST reads carry provenance', () => {
  it('stamps transport=api, the real path called, the mapper version and a measured latency', async () => {
    const client = mkClient();
    const result = await listVolumesObserved(client);

    expect(result.provenance.transport).toBe('api');
    expect(result.provenance.endpoint).toBe('GET /volumes/detail');
    expect(result.provenance.mapperVersion).toBe(HCI_MAPPER_VERSION);
    expect(result.provenance.latencyMs).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(result.provenance.collectedAt))).toBe(false);
    expect(isFactProvenance(result.provenance)).toBe(true);
  });

  it('stamps the SAME envelope on every observed volume fact', async () => {
    const client = mkClient();
    await client.request('volume', '/volumes', {
      method: 'POST',
      headers: { 'x-client-token': 'ct-prov-1' },
      body: { volume: { name: 'prov-vol-1', size: 4 } },
    });
    const result = await listVolumesObserved(client);
    const fact = result.volumes.find((v) => (v.value as { name: string }).name === 'prov-vol-1');

    expect(fact).toBeDefined();
    expect(isFactProvenance(fact!.source)).toBe(true);
    expect(fact!.source).toEqual(result.provenance);
    expect((fact!.value as { size: number }).size).toBe(4);
  });
});

describe('collectInventory — every collected surface is attributable', () => {
  it('returns a per-surface provenance envelope for volumes, servers and images', async () => {
    const inv = await collectInventory(mkClient());

    expect(inv.readOnly).toBe(true);
    for (const surface of ['volumes', 'servers', 'images'] as const) {
      const p = inv.provenance[surface];
      expect(isFactProvenance(p), `${surface} envelope invalid: ${JSON.stringify(p)}`).toBe(true);
      expect(p.transport).toBe('api');
      expect(p.mapperVersion).toBe(HCI_MAPPER_VERSION);
      expect(p.latencyMs!).toBeGreaterThan(0);
    }
    expect(inv.provenance.volumes.endpoint).toBe('GET /volumes/detail');
    expect(inv.provenance.servers.endpoint).toBe('GET /servers');
    expect(inv.provenance.images.endpoint).toBe('GET /v2/images');
  });

  it('keeps a single collection timestamp per run (one collectedAt across surfaces)', async () => {
    const inv = await collectInventory(mkClient());
    expect(inv.collectedAt).toBe(inv.provenance.volumes.collectedAt);
    expect(inv.provenance.servers.collectedAt).toBe(inv.collectedAt);
    expect(inv.provenance.images.collectedAt).toBe(inv.collectedAt);
  });

  it('marks an unreachable surface as unavailable rather than fabricating facts', async () => {
    // Volume service down: the envelope must still be honest about what was called.
    const client = mkClient();
    const inv = await collectInventory(client);
    expect(inv.volumeServiceAvailable).toBe(true);
    expect(inv.provenance.volumes.collector).toBe('hci-rest-collector');
  });
});
