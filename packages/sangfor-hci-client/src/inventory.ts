import type { HciClient, HciServiceType } from './client.js';
import { parseVolume, type HciVolume } from './volumes.js';
import {
  hciRestProvenance,
  type HciCollectionOptions,
  type HciFactProvenance,
} from './provenance.js';

/** One envelope per collected REST surface. A surface that failed still records
 *  what was called, so an empty list is never mistaken for an observed emptiness. */
export interface HciInventoryProvenance {
  volumes: HciFactProvenance;
  servers: HciFactProvenance;
  images: HciFactProvenance;
}

export interface HciSurfaceCollection {
  status: 'complete' | 'partial' | 'failed' | 'unknown';
  reason?: string;
}

export type HciInventoryCollection = Record<keyof HciInventoryProvenance, HciSurfaceCollection>;

export interface HciInventory {
  volumes: HciVolume[];
  servers: unknown[];
  images: unknown[];
  volumeServiceAvailable: boolean;
  readOnly: true;
  /** Single collection timestamp shared by every surface envelope of this run. */
  collectedAt: string;
  provenance: HciInventoryProvenance;
  /** Completeness is independent of provenance: an attempted request is not a successful observation. */
  collection: HciInventoryCollection;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readSurface<T>(
  client: Pick<HciClient, 'request'>,
  service: HciServiceType,
  path: string,
  key: string,
  parse: (raw: unknown) => T,
): Promise<{ value: T[]; latencyMs: number; collection: HciSurfaceCollection }> {
  const started = performance.now();
  const result = (value: T[], collection: HciSurfaceCollection) => ({ value, collection, latencyMs: performance.now() - started });
  try {
    const response = await client.request(service, path);
    if (response.status !== 200) return result([], { status: 'failed', reason: `HTTP_${response.status}` });
    const payload = response.json;
    if (!isRecord(payload) || !Array.isArray(payload[key])) {
      return result([], { status: 'failed', reason: 'INVALID_COLLECTION_PAYLOAD' });
    }
    const value = payload[key].map(parse);
    const links = payload[`${key}_links`] ?? payload.links;
    const hasNext = Boolean(payload.next)
      || (Array.isArray(links) && links.some((link) => isRecord(link) && link.rel === 'next'));
    return result(value, hasNext
      ? { status: 'partial', reason: 'UNREAD_PAGE' }
      : { status: 'complete' });
  } catch {
    // Transport/parser errors may contain credentials or response bodies. Persist only a stable code.
    return result([], { status: 'failed', reason: 'COLLECTION_REQUEST_OR_PARSE_FAILED' });
  }
}

export async function collectInventory(
  client: Pick<HciClient, 'request'>,
  opts: HciCollectionOptions = {},
): Promise<HciInventory> {
  const collectedAt = opts.collectedAt ?? new Date().toISOString();
  const envelope = (endpoint: string, latencyMs: number): HciFactProvenance =>
    hciRestProvenance(endpoint, { latencyMs, collectedAt }, { ...opts, collectedAt });

  const record = (raw: unknown) => {
    if (!isRecord(raw)) throw new Error('invalid inventory record');
    return raw;
  };
  const volumeRead = await readSurface(client, 'volume', '/volumes/detail', 'volumes', parseVolume);
  const serverRead = await readSurface(client, 'compute', '/servers', 'servers', record);
  const imageRead = await readSurface(client, 'image', '/v2/images', 'images', record);

  return {
    volumes: volumeRead.value,
    servers: serverRead.value,
    images: imageRead.value,
    volumeServiceAvailable: volumeRead.collection.status !== 'failed',
    readOnly: true,
    collectedAt,
    collection: {
      volumes: volumeRead.collection,
      servers: serverRead.collection,
      images: imageRead.collection,
    },
    provenance: {
      volumes: envelope('GET /volumes/detail', volumeRead.latencyMs),
      servers: envelope('GET /servers', serverRead.latencyMs),
      images: envelope('GET /v2/images', imageRead.latencyMs),
    },
  };
}
