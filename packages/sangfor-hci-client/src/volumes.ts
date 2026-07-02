import type { HciClient } from './client.js';

export interface HciVolume { id: string; name: string; status: string; size: number; description: string | null; }
export interface CreateVolumeInput { name: string; sizeGb: number; description?: string; }

export function parseVolume(raw: any): HciVolume {
  if (typeof raw?.id !== 'string' || typeof raw?.status !== 'string') {
    throw new Error('volume payload missing id/status (refusing to guess).');
  }
  return {
    id: raw.id,
    name: String(raw.name ?? ''),
    status: raw.status,
    size: Number(raw.size ?? 0),
    description: raw.description != null ? String(raw.description) : null,
  };
}

export async function listVolumes(client: HciClient): Promise<HciVolume[]> {
  const res = await client.request('volume', '/volumes/detail');
  if (res.status !== 200) throw new Error(`listVolumes failed: HTTP ${res.status}`);
  const raw = (res.json as { volumes?: unknown[] })?.volumes;
  if (!Array.isArray(raw)) throw new Error('listVolumes: response missing volumes[]');
  return raw.map(parseVolume);
}

export async function getVolume(client: HciClient, volumeId: string): Promise<HciVolume | null> {
  const res = await client.request('volume', `/volumes/${encodeURIComponent(volumeId)}`);
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error(`getVolume failed: HTTP ${res.status}`);
  return parseVolume((res.json as { volume?: unknown })?.volume);
}

export async function createVolume(
  client: HciClient,
  input: CreateVolumeInput,
  clientToken: string,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; volume: HciVolume | null }> {
  const res = await client.request('volume', '/volumes', {
    method: 'POST',
    headers: { 'x-client-token': clientToken, ...extraHeaders },
    body: { volume: { name: input.name, size: input.sizeGb, ...(input.description !== undefined ? { description: input.description } : {}) } },
  });
  const raw = (res.json as { volume?: unknown })?.volume;
  return { status: res.status, volume: raw ? parseVolume(raw) : null };
}

export async function deleteVolume(client: HciClient, volumeId: string): Promise<{ status: number }> {
  const res = await client.request('volume', `/volumes/${encodeURIComponent(volumeId)}`, { method: 'DELETE' });
  return { status: res.status };
}
