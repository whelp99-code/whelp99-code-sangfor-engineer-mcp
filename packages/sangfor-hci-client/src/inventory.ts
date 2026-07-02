import type { HciClient } from './client.js';
import { listVolumes, type HciVolume } from './volumes.js';

export async function collectInventory(
  client: HciClient,
): Promise<{ volumes: HciVolume[]; servers: unknown[]; images: unknown[]; volumeServiceAvailable: boolean; readOnly: true }> {
  let volumes: HciVolume[] = [];
  let volumeServiceAvailable = true;
  try {
    volumes = await listVolumes(client);
  } catch {
    volumes = [];
    volumeServiceAvailable = false;
  }
  const servers = await client
    .request('compute', '/servers')
    .then((r) => (r.status === 200 && Array.isArray((r.json as any)?.servers) ? (r.json as any).servers : []), () => []);
  const images = await client
    .request('image', '/v2/images')
    .then((r) => (r.status === 200 && Array.isArray((r.json as any)?.images) ? (r.json as any).images : []), () => []);
  return { volumes, servers, images, volumeServiceAvailable, readOnly: true };
}
