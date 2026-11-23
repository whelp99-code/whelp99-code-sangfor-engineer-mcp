import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  collectInventory,
  collectOfficialJanusHostExtras,
  isJanusHostsCaptureGrant,
  JANUS_HOSTS_PATH,
  janusHostsCollectRefusal,
  OFFICIAL_SCP_JANUS_HOSTS_ENDPOINT,
  type HciClient,
  type HttpJsonResult,
  type JanusHostsCaptureGrant,
} from '@sangfor/hci-client';

const WHEN = '2026-09-10T00:00:00.000Z';
const volume = { id: 'v1', name: 'data', status: 'available', size: 1, description: null };
const response = (json: unknown, status = 200): HttpJsonResult => ({ json, status, text: JSON.stringify(json) });

const SINGLE_HOSTS = JSON.parse(
  readFileSync('tests/fixtures/engineer-workflow/official-scp-janus-hosts-single.json', 'utf8'),
) as unknown;
const MULTI_HOSTS = JSON.parse(
  readFileSync('tests/fixtures/engineer-workflow/official-scp-janus-hosts-multi.json', 'utf8'),
) as unknown;

function keystoneClient(paths: string[]): Pick<HciClient, 'request'> {
  return {
    async request(service, path, init) {
      expect(init?.method ?? 'GET').toBe('GET');
      expect(path.includes('janus')).toBe(false);
      expect(String(service)).not.toBe('janus');
      paths.push(`${service}:${path}`);
      if (service === 'volume') return response({ volumes: [volume] });
      if (service === 'compute') return response({ servers: [{ id: 's1' }] });
      return response({ images: [] });
    },
  };
}

function captureGrant(payload: unknown, counter: { get: number }, status = 200): JanusHostsCaptureGrant {
  return {
    kind: 'explicit_janus_hosts_capture',
    client: {
      async getOfficialHosts(request) {
        expect(request.method).toBe('GET');
        expect(request.path).toBe(JANUS_HOSTS_PATH);
        expect(request.endpoint).toBe(OFFICIAL_SCP_JANUS_HOSTS_ENDPOINT);
        counter.get += 1;
        return { status, json: payload, latencyMs: 5 };
      },
    },
  };
}

describe('Janus hosts child adapter', () => {
  it('refuses an invalid grant and does not GET', async () => {
    const counter = { get: 0 };
    expect(isJanusHostsCaptureGrant(undefined)).toBe(false);
    expect(isJanusHostsCaptureGrant({ kind: 'please_get_janus' })).toBe(false);
    expect(janusHostsCollectRefusal()).toEqual({
      status: 'capture_gated',
      getCount: 0,
      reason: 'JANUS_CAPTURE_GATED',
      endpoint: OFFICIAL_SCP_JANUS_HOSTS_ENDPOINT,
    });

    const refused = await collectOfficialJanusHostExtras({
      grant: { kind: 'please_get_janus', client: { getOfficialHosts: async () => { counter.get += 1; return { status: 200, json: SINGLE_HOSTS }; } } },
      collectedAt: WHEN,
    });
    expect(refused.report.status).toBe('capture_gated');
    expect(refused.report.getCount).toBe(0);
    expect(refused.extras).toEqual([]);
    expect(counter.get).toBe(0);
  });

  it('maps a PDF-shaped single-host fixture and refuses multi-host sums', async () => {
    const singleCounter = { get: 0 };
    const single = await collectOfficialJanusHostExtras({
      grant: captureGrant(SINGLE_HOSTS, singleCounter),
      collectedAt: WHEN,
    });
    expect(singleCounter.get).toBe(1);
    expect(single.report).toEqual({
      status: 'captured',
      getCount: 1,
      endpoint: OFFICIAL_SCP_JANUS_HOSTS_ENDPOINT,
    });
    expect(single.extras.map((item) => item.surfaceId).sort()).toEqual(['host_cpu', 'host_ram']);
    expect(single.extras.find((item) => item.surfaceId === 'host_cpu')?.payload).toEqual({
      presence: 'known',
      data: { kind: 'integer', integer: 4, unit: 'cores' },
    });
    expect(single.extras.find((item) => item.surfaceId === 'host_ram')?.payload).toEqual({
      presence: 'known',
      data: { kind: 'integer', integer: 32768, unit: 'MB' },
    });
    expect(single.extras.some((item) => item.surfaceId === 'storage_usable_capacity')).toBe(false);
    expect(single.extras.some((item) => item.surfaceId === 'ha_status')).toBe(false);

    const multiCounter = { get: 0 };
    const multi = await collectOfficialJanusHostExtras({
      grant: captureGrant(MULTI_HOSTS, multiCounter),
      collectedAt: WHEN,
    });
    expect(multiCounter.get).toBe(1);
    expect(multi.extras).toEqual([]);
  });

  it('keeps production collectInventory gated off so Keystone never GETs Janus', async () => {
    const paths: string[] = [];

    const inventory = await collectInventory(keystoneClient(paths), { collectedAt: WHEN });
    expect(inventory.janusHostsCollect).toEqual({
      status: 'capture_gated',
      getCount: 0,
      reason: 'JANUS_CAPTURE_GATED',
      endpoint: OFFICIAL_SCP_JANUS_HOSTS_ENDPOINT,
    });
    expect(paths).toEqual([
      'volume:/volumes/detail',
      'compute:/servers',
      'image:/v2/images',
    ]);
    expect(inventory.readRequests).toEqual([
      { method: 'GET', service: 'volume', path: '/volumes/detail' },
      { method: 'GET', service: 'compute', path: '/servers' },
      { method: 'GET', service: 'image', path: '/v2/images' },
    ]);
    expect(inventory.originalPresentSurfaces).toBeUndefined();
    expect(inventory.fields.find((field) => field.id === 'host_cpu')?.sourceKind).toBe('unknown');
    expect(inventory.fields.find((field) => field.id === 'host_ram')?.sourceKind).toBe('unknown');
    expect(inventory.fields.find((field) => field.id === 'ha_status')?.sourceKind).toBe('unknown');
  });
});
