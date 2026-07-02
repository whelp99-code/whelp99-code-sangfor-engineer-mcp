import type { HciClient } from './client.js';
import { listVolumes, type HciVolume } from './volumes.js';

export async function collectInventory(
  client: HciClient,
): Promise<{ volumes: HciVolume[]; servers: unknown[]; images: unknown[]; readOnly: true }> {
  const volumes = await listVolumes(client);
  const servers = await client
    .request('compute', '/servers')
    .then((r) => (r.status === 200 && Array.isArray((r.json as any)?.servers) ? (r.json as any).servers : []), () => []);
  const images = await client
    .request('image', '/v2/images')
    .then((r) => (r.status === 200 && Array.isArray((r.json as any)?.images) ? (r.json as any).images : []), () => []);
  return { volumes, servers, images, readOnly: true };
}
