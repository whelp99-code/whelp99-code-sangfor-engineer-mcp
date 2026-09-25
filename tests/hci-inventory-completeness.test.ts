import { describe, expect, it } from 'vitest';
import { collectInventory, renderHciHealthReport, resolveSameOriginPage, summarizeHciHealth } from '@sangfor/hci-client';
import type { HciClient, HttpJsonResult } from '@sangfor/hci-client';

const volume = { id: 'v1', name: 'data', status: 'available', size: 1, description: null };
const response = (json: unknown, status = 200): HttpJsonResult => ({ json, status, text: JSON.stringify(json) });

function client(overrides: Partial<Record<string, HttpJsonResult | Error>> = {}): Pick<HciClient, 'request'> {
  const defaults: Record<string, HttpJsonResult> = {
    volume: response({ volumes: [volume] }), compute: response({ servers: [] }), image: response({ images: [] }),
  };
  return { async request(service, _path, init) {
    expect(init?.method ?? 'GET').toBe('GET');
    const result = overrides[service] ?? defaults[service];
    if (result instanceof Error) throw result;
    if (!result) throw new Error('unexpected service');
    return result;
  } };
}

describe('HCI collection completeness and health verdict', () => {
  it('distinguishes successful empty collection from unproven empty inventory', async () => {
    const inventory = await collectInventory(client({ volume: response({ volumes: [] }) }));
    expect(inventory.collection.volumes.status).toBe('complete');
    expect(summarizeHciHealth(inventory).verdict).toBe('INDETERMINATE');
    const expectedEmpty = summarizeHciHealth(inventory, { expectedEmpty: true });
    expect(expectedEmpty.verdict).toBe('PASS');
    expect(expectedEmpty.scope).toBe('volume-status');
  });

  it.each([
    ['volume', response({ message: 'denied' }, 403)],
    ['compute', response({ message: 'unauthorized' }, 401)],
    ['image', response({ images: 'invalid' })],
    ['compute', new Error('password=must-not-be-persisted')],
  ] as const)('reports failed %s collection without inventing empty-state success', async (service, failure) => {
    const inventory = await collectInventory(client({ [service]: failure }));
    const surface = service === 'volume' ? 'volumes' : service === 'compute' ? 'servers' : 'images';
    expect(inventory.collection[surface].status).toBe('failed');
    const summary = summarizeHciHealth(inventory, { expectedEmpty: true });
    expect(summary).toMatchObject({ verdict: 'INDETERMINATE', healthy: false });
    expect(renderHciHealthReport(summary)).toContain('판정 불가');
    expect(JSON.stringify(inventory)).not.toContain('must-not-be-persisted');
  });

  it('marks a response with another page as partial, and never follows an untrusted next URL', async () => {
    const inventory = await collectInventory(client({
      volume: response({ volumes: [volume], volumes_links: [{ rel: 'next', href: 'https://untrusted.invalid/next' }] }),
    }));
    expect(inventory.collection.volumes.status).toBe('partial');
    expect(summarizeHciHealth(inventory)).toMatchObject({ verdict: 'INDETERMINATE', healthy: false });
  });

  it('preserves a confirmed error even when another surface failed', async () => {
    const inventory = await collectInventory(client({
      volume: response({ volumes: [{ ...volume, status: 'error_deleting' }] }),
      compute: response({}, 403),
    }));
    expect(summarizeHciHealth(inventory)).toMatchObject({ verdict: 'FAIL', healthy: false });
    expect(renderHciHealthReport(summarizeHciHealth(inventory))).toContain('조치 필요');
  });

  it.each(['creating', 'deleting', 'unknown-vendor-state'])('does not call %s a healthy volume state', async (status) => {
    const inventory = await collectInventory(client({ volume: response({ volumes: [{ ...volume, status }] }) }));
    expect(summarizeHciHealth(inventory)).toMatchObject({ verdict: 'INDETERMINATE', healthy: false });
  });

  it('claims PASS only for the observed volume scope with complete collection', async () => {
    const inventory = await collectInventory(client());
    expect(summarizeHciHealth(inventory)).toMatchObject({ verdict: 'PASS', healthy: true, scope: 'volume-status' });
    expect(renderHciHealthReport(summarizeHciHealth(inventory))).toContain('클러스터 전체 건강 판정은 포함하지 않음');
  });

  it('distinguishes captured healthy state from current freshness', async () => {
    const inventory = { ...await collectInventory(client()), collectedAt: '2026-09-08T00:00:00.000Z' };
    expect(summarizeHciHealth(inventory).assessment.mode).toBe('snapshot');
    expect(summarizeHciHealth(inventory, { mode: 'current' }).verdict).toBe('INDETERMINATE');
    expect(summarizeHciHealth(inventory, { mode: 'current', maxAgeSec: 60, now: '2026-09-08T00:00:30.000Z' }).verdict).toBe('PASS');
    expect(summarizeHciHealth(inventory, { mode: 'current', maxAgeSec: 60, now: '2026-09-08T00:02:00.000Z' }).findings).toContain('evidence-expired: 관측 유효시간 초과');
    expect(summarizeHciHealth(inventory, { mode: 'current', maxAgeSec: 60, now: '2026-09-07T23:59:59.000Z' }).verdict).toBe('INDETERMINATE');
    expect(summarizeHciHealth({ ...inventory, collectedAt: undefined }, { mode: 'current', maxAgeSec: 60 }).verdict).toBe('INDETERMINATE');
  });

  it('records required-field completeness and never dispatches a mutation', async () => {
    const inventory = await collectInventory(client(), {
      collectedAt: '2026-09-09T00:00:00.000Z',
      request: { target: '127.0.0.1', identityOrigin: 'http://127.0.0.1:3400/openstack/identity/v2.0' },
    });
    expect(inventory.readOnly).toBe(true);
    expect(inventory.mutationDispatchCount).toBe(0);
    expect(inventory.persisted).toBe(false);
    expect(inventory.guideReadyGranted).toBe(false);
    expect(inventory.readRequests.every((read) => read.method === 'GET')).toBe(true);
    expect(inventory.request.surfaces).toEqual(['volumes', 'servers', 'images']);
    expect(inventory.fields.map((field) => field.id)).toEqual([
      'volumes', 'servers', 'images', 'collectedAt', 'volume_status_health',
      'firmware', 'host_cpu', 'host_ram', 'storage_usable_capacity', 'network_topology', 'ha_status',
    ]);
    expect(inventory.fields.find((field) => field.id === 'volumes')).toMatchObject({ availability: 'collected' });
    expect(inventory.fields.find((field) => field.id === 'ha_status')).toMatchObject({
      availability: 'missing',
      collectionStatus: 'unsupported',
      importPath: 'manual-provided',
    });
    expect(inventory.capabilityMatrix.some((row) => row.id === 'hci.collect.volumes' && row.support === 'implemented')).toBe(true);
    expect(inventory.capabilityMatrix.some((row) => row.id === 'hci.collect.ha_status' && row.support === 'unsupported')).toBe(true);
    expect(inventory.collectionRevision).toMatch(/^[a-f0-9]{64}$/);
  });

  it('refuses a wrong target before any surface read and does not treat that as an empty healthy inventory', async () => {
    const inventory = await collectInventory(client(), {
      request: { target: 'evil.example', identityOrigin: 'http://127.0.0.1:3400/openstack/identity/v2.0' },
    });
    expect(inventory.readRequests).toEqual([]);
    expect(inventory.volumes).toEqual([]);
    expect(inventory.collection.volumes).toMatchObject({ status: 'failed', reason: 'WRONG_TARGET' });
    expect(summarizeHciHealth(inventory, { expectedEmpty: true })).toMatchObject({ verdict: 'INDETERMINATE', healthy: false });
  });

  it('classifies auth failure, timeout, and schema change without inventing an empty device', async () => {
    const denied = await collectInventory(client({ volume: response({ message: 'denied' }, 403) }));
    expect(denied.collection.volumes).toMatchObject({ status: 'failed', reason: 'AUTH_FAILED' });
    const timedOut = await collectInventory(client({ compute: new Error('HTTP timeout: GET http://127.0.0.1/servers') }));
    expect(timedOut.collection.servers).toMatchObject({ status: 'failed', reason: 'TIMEOUT' });
    const schema = await collectInventory(client({
      volume: response({ volumes: [{ name: 'no-id', status: 'available', size: 1, description: null }] }),
    }));
    expect(schema.collection.volumes).toMatchObject({ status: 'failed', reason: 'SCHEMA_CHANGED' });
    expect(schema.volumes).toEqual([]);
  });

  it('follows a same-origin next page and stops at the page cap as partial', async () => {
    const page2 = { id: 'v2', name: 'more', status: 'available', size: 2, description: null };
    const pagingClient: Pick<HciClient, 'request'> = {
      async request(service, path, init) {
        expect(init?.method ?? 'GET').toBe('GET');
        if (service !== 'volume') {
          const key = service === 'compute' ? 'servers' : 'images';
          return response({ [key]: [] });
        }
        if (String(path).includes('marker=v1')) return response({ volumes: [page2] });
        return response({
          volumes: [volume],
          volumes_links: [{
            rel: 'next',
            href: 'http://127.0.0.1:3400/openstack/volume/v2/lab/volumes/detail?marker=v1',
          }],
        });
      },
    };
    const complete = await collectInventory(pagingClient, {
      request: { serviceOrigins: { volume: 'http://127.0.0.1:3400/openstack/volume/v2/lab' } },
    });
    expect(complete.collection.volumes.status).toBe('complete');
    expect(complete.volumes.map((item) => item.id)).toEqual(['v1', 'v2']);

    const capped = await collectInventory(pagingClient, {
      request: {
        maxPages: 1,
        serviceOrigins: { volume: 'http://127.0.0.1:3400/openstack/volume/v2/lab' },
      },
    });
    expect(capped.collection.volumes).toMatchObject({ status: 'partial', reason: 'PAGE_LIMIT' });
    expect(capped.volumes.map((item) => item.id)).toEqual(['v1']);
  });

  it('keeps an external-origin next link unread', async () => {
    const inventory = await collectInventory(client({
      volume: response({ volumes: [volume], volumes_links: [{ rel: 'next', href: 'https://untrusted.invalid/next' }] }),
    }), {
      request: { serviceOrigins: { volume: 'http://127.0.0.1:3400/openstack/volume/v2/lab' } },
    });
    expect(inventory.collection.volumes).toMatchObject({ status: 'partial', reason: 'EXTERNAL_ORIGIN' });
    expect(inventory.volumes).toEqual([expect.objectContaining({ id: 'v1' })]);
  });

  it('refuses a protocol-relative next link as an external origin', async () => {
    const serviceBase = 'http://127.0.0.1:3400/openstack/volume/v2/lab';
    expect(resolveSameOriginPage('//untrusted.invalid/stolen', serviceBase))
      .toEqual({ ok: false, reason: 'EXTERNAL_ORIGIN' });
    expect(resolveSameOriginPage('  //untrusted.invalid/stolen', serviceBase))
      .toEqual({ ok: false, reason: 'EXTERNAL_ORIGIN' });
    expect(resolveSameOriginPage('/volumes/detail?marker=v1', serviceBase))
      .toEqual({ ok: true, path: '/volumes/detail?marker=v1' });

    const inventory = await collectInventory(client({
      volume: response({ volumes: [volume], volumes_links: [{ rel: 'next', href: '//untrusted.invalid/stolen' }] }),
    }), {
      request: { serviceOrigins: { volume: serviceBase } },
    });
    expect(inventory.collection.volumes).toMatchObject({ status: 'partial', reason: 'EXTERNAL_ORIGIN' });
    expect(inventory.volumes).toEqual([expect.objectContaining({ id: 'v1' })]);
    expect(inventory.readRequests.filter((read) => read.service === 'volume')).toHaveLength(1);
  });
});
