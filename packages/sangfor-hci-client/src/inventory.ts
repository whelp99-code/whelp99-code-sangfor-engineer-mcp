import type { HciClient } from './client.js';
import { listVolumes, type HciVolume } from './volumes.js';
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

export interface HciInventory {
  volumes: HciVolume[];
  servers: unknown[];
  images: unknown[];
  volumeServiceAvailable: boolean;
  readOnly: true;
  /** Single collection timestamp shared by every surface envelope of this run. */
  collectedAt: string;
  provenance: HciInventoryProvenance;
}

/** Time one surface read; the caller decides what an error means for the surface. */
async function timed<T>(read: () => Promise<T>): Promise<{ value: T; latencyMs: number }> {
  const started = performance.now();
  const value = await read();
  return { value, latencyMs: performance.now() - started };
}

export async function collectInventory(
  client: HciClient,
  opts: HciCollectionOptions = {},
): Promise<HciInventory> {
  const collectedAt = opts.collectedAt ?? new Date().toISOString();
  const envelope = (endpoint: string, latencyMs: number): HciFactProvenance =>
    hciRestProvenance(endpoint, { latencyMs, collectedAt }, { ...opts, collectedAt });

  let volumes: HciVolume[] = [];
  let volumeServiceAvailable = true;
  const volumeRead = await timed(async () => {
    try {
      return await listVolumes(client);
    } catch {
      volumeServiceAvailable = false;
      return [] as HciVolume[];
    }
  });
  volumes = volumeRead.value;

  const serverRead = await timed(() => client
    .request('compute', '/servers')
    .then((r) => (r.status === 200 && Array.isArray((r.json as any)?.servers) ? (r.json as any).servers as unknown[] : []), () => [] as unknown[]));
  const imageRead = await timed(() => client
    .request('image', '/v2/images')
    .then((r) => (r.status === 200 && Array.isArray((r.json as any)?.images) ? (r.json as any).images as unknown[] : []), () => [] as unknown[]));

  return {
    volumes,
    servers: serverRead.value,
    images: imageRead.value,
    volumeServiceAvailable,
    readOnly: true,
    collectedAt,
    provenance: {
      volumes: envelope('GET /volumes/detail', volumeRead.latencyMs),
      servers: envelope('GET /servers', serverRead.latencyMs),
      images: envelope('GET /v2/images', imageRead.latencyMs),
    },
  };
}
