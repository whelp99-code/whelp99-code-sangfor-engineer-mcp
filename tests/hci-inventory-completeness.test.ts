import { describe, expect, it } from 'vitest';
import { collectInventory, renderHciHealthReport, summarizeHciHealth } from '@sangfor/hci-client';
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
});
