import type { HciServiceType } from './client.js';
import { parseVolume, type HciVolume } from './volumes.js';
import {
  hciRestProvenance,
  type HciCollectionOptions,
  type HciFactProvenance,
  type HciInventoryCollectedSurface,
} from './provenance.js';
import {
  HCI_E03A_CAPABILITY_MATRIX,
  assertCollectionTarget,
  buildRequiredFieldStatuses,
  collectionFailureReason,
  digestCollectionRevision,
  isRecord,
  nextPageHref,
  paginationLimits,
  requestedSurfaces,
  requiredObservationsFromOptions,
  resolveSameOriginPage,
  serviceOriginFor,
  wrapReadOnlyClient,
  type HciCapabilityRow,
  type HciReadRequestRecord,
  type HciRequiredFieldStatus,
  type InventoryClient,
} from './collection.js';
import type { HciRequiredObservationResult } from './required-observations.js';
import {
  applyObservedExtrasToFields,
  extractOriginalPresentSurfacesFromPages,
  mergeCollectExtraSurfaces,
  type HciCollectExtraPage,
  type HciInventoryOriginalPresentSurface,
} from './collect-extras.js';
import {
  collectOfficialJanusHostExtras,
  type JanusHostsCollectReport,
} from './janus-hosts-adapter.js';

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
  /** Declared target/scope/surfaces. This is not cluster/network coverage. */
  request: {
    target?: string;
    firmwareVersion?: string;
    surfaces: readonly HciInventoryCollectedSurface[];
    scope?: { tenantId?: string; projectId?: string };
  };
  fields: readonly HciRequiredFieldStatus[];
  capabilityMatrix: readonly HciCapabilityRow[];
  readRequests: readonly HciReadRequestRecord[];
  mutationDispatchCount: 0;
  persisted: false;
  collectionRevision: string;
  guideReadyGranted: false;
  requiredObservations: HciRequiredObservationResult;
  /**
   * Grant extras taken from already-fetched REST JSON only.
   * Absent when the device/API omitted the explicit keys.
   */
  originalPresentSurfaces?: readonly HciInventoryOriginalPresentSurface[];
  /** Official Janus hosts GET status. Production collect stays capture_gated. */
  janusHostsCollect: JanusHostsCollectReport;
  manualImport: {
    allowed: true;
    promotesTo: 'provided';
    neverObserved: true;
  };
}

const SURFACE_META: Record<HciInventoryCollectedSurface, {
  service: HciServiceType;
  path: string;
  key: string;
  endpoint: string;
}> = {
  volumes: { service: 'volume', path: '/volumes/detail', key: 'volumes', endpoint: 'GET /volumes/detail' },
  servers: { service: 'compute', path: '/servers', key: 'servers', endpoint: 'GET /servers' },
  images: { service: 'image', path: '/v2/images', key: 'images', endpoint: 'GET /v2/images' },
};

async function readSurface<T>(
  client: InventoryClient,
  service: HciServiceType,
  path: string,
  key: string,
  parse: (raw: unknown) => T,
  opts: HciCollectionOptions,
  endpoint: string,
  collectedAt: string,
): Promise<{
  value: T[];
  latencyMs: number;
  collection: HciSurfaceCollection;
  pages: number;
  extraPages: HciCollectExtraPage[];
}> {
  const started = performance.now();
  const { maxPages, maxPageTimeMs } = paginationLimits(opts.request);
  const serviceBase = await serviceOriginFor(client, service, opts.request);
  const seen = new Set<string>();
  const value: T[] = [];
  const extraPages: HciCollectExtraPage[] = [];
  let currentPath = path;
  let pages = 0;

  const finish = (collection: HciSurfaceCollection) => {
    const latencyMs = performance.now() - started;
    return {
      value,
      collection,
      pages,
      extraPages: extraPages.map((page) => ({
        ...page,
        endpoint,
        latencyMs,
        collectedAt,
      })),
      latencyMs,
    };
  };

  while (true) {
    if (performance.now() - started > maxPageTimeMs) {
      return finish({
        status: value.length > 0 ? 'partial' : 'failed',
        reason: 'TIME_LIMIT',
      });
    }
    if (pages >= maxPages) {
      return finish({ status: 'partial', reason: 'PAGE_LIMIT' });
    }
    if (seen.has(currentPath)) {
      return finish({ status: 'partial', reason: 'PAGE_LOOP' });
    }
    seen.add(currentPath);
    pages += 1;

    try {
      const response = await client.request(service, currentPath);
      if (response.status !== 200) {
        if (pages === 1) {
          return finish({ status: 'failed', reason: collectionFailureReason(undefined, response.status) });
        }
        return finish({ status: 'partial', reason: collectionFailureReason(undefined, response.status) });
      }
      const payload = response.json;
      if (!isRecord(payload) || !Array.isArray(payload[key])) {
        return finish({
          status: pages === 1 && value.length === 0 ? 'failed' : 'partial',
          reason: 'SCHEMA_CHANGED',
        });
      }
      try {
        value.push(...payload[key].map(parse));
      } catch (error) {
        return finish({
          status: pages === 1 && value.length === 0 ? 'failed' : 'partial',
          reason: collectionFailureReason(error),
        });
      }
      extraPages.push({
        endpoint,
        payload,
        latencyMs: 0,
        collectedAt,
      });
      const next = nextPageHref(payload, key);
      if (!next) return finish({ status: 'complete' });
      const resolved = resolveSameOriginPage(next, serviceBase);
      if (!resolved.ok) {
        return finish({ status: 'partial', reason: resolved.reason });
      }
      currentPath = resolved.path;
    } catch (error) {
      return finish({
        status: pages === 1 && value.length === 0 ? 'failed' : 'partial',
        reason: collectionFailureReason(error),
      });
    }
  }
}

function emptySurface(reason: string): {
  value: never[];
  latencyMs: number;
  collection: HciSurfaceCollection;
  pages: number;
  extraPages: HciCollectExtraPage[];
} {
  return { value: [], latencyMs: 0, collection: { status: 'failed', reason }, pages: 0, extraPages: [] };
}

export async function collectInventory(
  client: InventoryClient,
  opts: HciCollectionOptions = {},
): Promise<HciInventory> {
  const collectedAt = opts.collectedAt ?? new Date().toISOString();
  const reads: HciReadRequestRecord[] = [];
  const readClient = wrapReadOnlyClient(client, reads);
  const surfaces = requestedSurfaces(opts.request);
  const targetCheck = await assertCollectionTarget(client, opts.request);
  const envelope = (endpoint: string, latencyMs: number): HciFactProvenance =>
    hciRestProvenance(endpoint, { latencyMs, collectedAt }, { ...opts, collectedAt });

  const record = (raw: unknown) => {
    if (!isRecord(raw)) throw new Error('invalid inventory record');
    return raw;
  };

  const skipped = (reason: string) => emptySurface(reason);
  const volumeRead = !targetCheck.ok
    ? skipped(targetCheck.reason)
    : surfaces.includes('volumes')
      ? await readSurface(
        readClient, 'volume', SURFACE_META.volumes.path, 'volumes', parseVolume, opts,
        SURFACE_META.volumes.endpoint, collectedAt,
      )
      : skipped('SURFACE_NOT_REQUESTED');
  const serverRead = !targetCheck.ok
    ? skipped(targetCheck.reason)
    : surfaces.includes('servers')
      ? await readSurface(
        readClient, 'compute', SURFACE_META.servers.path, 'servers', record, opts,
        SURFACE_META.servers.endpoint, collectedAt,
      )
      : skipped('SURFACE_NOT_REQUESTED');
  const imageRead = !targetCheck.ok
    ? skipped(targetCheck.reason)
    : surfaces.includes('images')
      ? await readSurface(
        readClient, 'image', SURFACE_META.images.path, 'images', record, opts,
        SURFACE_META.images.endpoint, collectedAt,
      )
      : skipped('SURFACE_NOT_REQUESTED');

  const collection: HciInventoryCollection = {
    volumes: volumeRead.collection,
    servers: serverRead.collection,
    images: imageRead.collection,
  };
  const requiredObservations = requiredObservationsFromOptions(opts);
  const unofficialExtras = extractOriginalPresentSurfacesFromPages([
    ...volumeRead.extraPages,
    ...serverRead.extraPages,
    ...imageRead.extraPages,
  ]);
  const janusHosts = await collectOfficialJanusHostExtras({
    grant: opts.janusHostsCapture,
    collectedAt,
  });
  const originalPresentSurfaces = mergeCollectExtraSurfaces(janusHosts.extras, unofficialExtras);
  const fields = applyObservedExtrasToFields(buildRequiredFieldStatuses({
    collection,
    collectedAt,
    firmwareVersion: opts.firmwareVersion,
    requested: surfaces,
    providedFields: opts.providedFields,
    attemptedRequiredReads: opts.attemptedRequiredReads,
    requiredObservations,
  }), originalPresentSurfaces);
  const request = {
    ...(opts.request?.target ? { target: opts.request.target } : {}),
    ...(opts.firmwareVersion ? { firmwareVersion: opts.firmwareVersion } : {}),
    surfaces,
    ...(opts.request?.scope ? { scope: opts.request.scope } : {}),
  };
  const collectionRevision = digestCollectionRevision({
    collectedAt,
    request,
    collection,
    volumes: volumeRead.value,
    servers: serverRead.value,
    images: imageRead.value,
    fields,
    originalPresentSurfaces,
    janusHostsCollect: janusHosts.report,
  });

  return {
    volumes: volumeRead.value,
    servers: serverRead.value,
    images: imageRead.value,
    volumeServiceAvailable: volumeRead.collection.status !== 'failed',
    readOnly: true,
    collectedAt,
    collection,
    provenance: {
      volumes: envelope(SURFACE_META.volumes.endpoint, volumeRead.latencyMs),
      servers: envelope(SURFACE_META.servers.endpoint, serverRead.latencyMs),
      images: envelope(SURFACE_META.images.endpoint, imageRead.latencyMs),
    },
    request,
    fields,
    capabilityMatrix: HCI_E03A_CAPABILITY_MATRIX,
    readRequests: reads,
    mutationDispatchCount: 0,
    persisted: false,
    collectionRevision,
    guideReadyGranted: false,
    requiredObservations,
    ...(originalPresentSurfaces.length > 0 ? { originalPresentSurfaces } : {}),
    janusHostsCollect: janusHosts.report,
    manualImport: { allowed: true, promotesTo: 'provided', neverObserved: true },
  };
}
