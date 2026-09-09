import { createHash } from 'node:crypto';
import { canonicalizeUrlOrigin } from '@sangfor/shared';
import { maskSecrets } from './audit-ledger.js';
import type { HciClient, HciServiceType } from './client.js';
import {
  HCI_INVENTORY_COLLECTED_SURFACES,
  type HciCollectionOptions,
  type HciCollectionRequest,
  type HciInventoryCollectedSurface,
} from './provenance.js';
import {
  HCI_E03B_CAPABILITIES,
  collectRequiredObservations,
  type HciRequiredObservationAcquisition,
  type HciRequiredObservationResult,
} from './required-observations.js';

export const HCI_COLLECTION_DEFAULT_MAX_PAGES = 8;
export const HCI_COLLECTION_DEFAULT_MAX_PAGE_TIME_MS = 10_000;

export type HciFieldAvailability = 'collected' | 'provided' | 'missing';

export type HciRequiredFieldStatus = {
  readonly id: string;
  readonly availability: HciFieldAvailability;
  readonly reason: string;
  readonly collectionStatus: 'complete' | 'partial' | 'missing' | 'failed' | 'unsupported';
  readonly sourceKind: 'observed' | 'provided' | 'unknown';
  readonly importPath?: 'manual-provided';
  readonly acquisition?: HciRequiredObservationAcquisition;
};

export type HciCapabilityRow = {
  readonly id: string;
  readonly title: string;
  readonly support: 'implemented' | 'unsupported';
  readonly transport: 'api' | 'none';
  readonly surfaces: readonly string[];
};

export type HciReadRequestRecord = {
  readonly method: 'GET';
  readonly service: HciServiceType;
  readonly path: string;
};

export const HCI_E03A_CAPABILITY_MATRIX: readonly HciCapabilityRow[] = [
  {
    id: 'hci.collect.volumes',
    title: 'HCI GET /volumes/detail',
    support: 'implemented',
    transport: 'api',
    surfaces: ['volumes'],
  },
  {
    id: 'hci.collect.servers',
    title: 'HCI GET /servers',
    support: 'implemented',
    transport: 'api',
    surfaces: ['servers'],
  },
  {
    id: 'hci.collect.images',
    title: 'HCI GET /v2/images',
    support: 'implemented',
    transport: 'api',
    surfaces: ['images'],
  },
  ...HCI_E03B_CAPABILITIES.map((row) => ({
    id: row.id,
    title: row.title,
    support: row.support,
    transport: row.transport,
    surfaces: row.surfaces,
  })),
];

export const HCI_E03A_REQUIRED_FIELDS = [
  'volumes',
  'servers',
  'images',
  'collectedAt',
  'volume_status_health',
  'firmware',
  'host_cpu',
  'host_ram',
  'storage_usable_capacity',
  'network_topology',
  'ha_status',
] as const;

export type InventoryClient = Pick<HciClient, 'request'> & Partial<Pick<HciClient, 'endpointFor'>>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function requestedSurfaces(request: HciCollectionRequest | undefined): readonly HciInventoryCollectedSurface[] {
  const surfaces = request?.surfaces ?? HCI_INVENTORY_COLLECTED_SURFACES;
  return HCI_INVENTORY_COLLECTED_SURFACES.filter((surface) => surfaces.includes(surface));
}

export function collectionFailureReason(error: unknown, status?: number): string {
  if (status === 401 || status === 403) return 'AUTH_FAILED';
  if (status !== undefined && status !== 200) return `HTTP_${status}`;
  const message = error instanceof Error ? error.message : '';
  if (/timeout/i.test(message)) return 'TIMEOUT';
  if (/invalid inventory record|missing id\/status/i.test(message)) return 'SCHEMA_CHANGED';
  return 'COLLECTION_REQUEST_OR_PARSE_FAILED';
}

function hostOf(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(trimmed)) return new URL(trimmed).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (/[/?#]/.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

export function targetsMatch(declared: string, actual: string): boolean {
  const declaredIsUrl = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(declared.trim());
  const actualIsUrl = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(actual.trim());
  if (declaredIsUrl && actualIsUrl) {
    try {
      return canonicalizeUrlOrigin(declared, 'url') === canonicalizeUrlOrigin(actual, 'url');
    } catch {
      return false;
    }
  }
  const declaredHost = hostOf(declared);
  const actualHost = hostOf(actual);
  return Boolean(declaredHost && actualHost && declaredHost === actualHost);
}

export async function resolveIdentityOrigin(
  client: InventoryClient,
  request: HciCollectionRequest | undefined,
): Promise<string | undefined> {
  if (request?.identityOrigin) return request.identityOrigin;
  if (typeof client.endpointFor !== 'function') return undefined;
  try {
    return await client.endpointFor('identity');
  } catch {
    return undefined;
  }
}

export async function assertCollectionTarget(
  client: InventoryClient,
  request: HciCollectionRequest | undefined,
): Promise<{ ok: true } | { ok: false; reason: 'WRONG_TARGET' | 'TARGET_UNVERIFIED' }> {
  if (!request?.target) return { ok: true };
  const actual = await resolveIdentityOrigin(client, request);
  if (!actual) return { ok: false, reason: 'TARGET_UNVERIFIED' };
  return targetsMatch(request.target, actual) ? { ok: true } : { ok: false, reason: 'WRONG_TARGET' };
}

export function nextPageHref(payload: Record<string, unknown>, key: string): string | undefined {
  if (typeof payload.next === 'string' && payload.next.length > 0) return payload.next;
  const links = payload[`${key}_links`] ?? payload.links;
  if (!Array.isArray(links)) return undefined;
  const next = links.find((link) => isRecord(link) && link.rel === 'next' && typeof link.href === 'string');
  return next && isRecord(next) && typeof next.href === 'string' ? next.href : undefined;
}

export function resolveSameOriginPage(
  next: string,
  serviceBase: string | undefined,
): { ok: true; path: string } | { ok: false; reason: 'EXTERNAL_ORIGIN' | 'INVALID_NEXT' } {
  const href = next.trim();
  if (!href) return { ok: false, reason: 'INVALID_NEXT' };
  // Protocol-relative next (`//host/...`) is an external origin. Refuse it
  // here so a later `new URL(path, base)` client cannot inherit our scheme.
  if (href.startsWith('//')) return { ok: false, reason: 'EXTERNAL_ORIGIN' };
  if (href.startsWith('/') || href.startsWith('?')) {
    return { ok: true, path: href };
  }
  let nextUrl: URL;
  try {
    nextUrl = new URL(href);
  } catch {
    return { ok: false, reason: 'INVALID_NEXT' };
  }
  if (!serviceBase) return { ok: false, reason: 'EXTERNAL_ORIGIN' };
  let serviceUrl: URL;
  try {
    serviceUrl = new URL(serviceBase.includes('://') ? serviceBase : `http://${serviceBase}`);
  } catch {
    return { ok: false, reason: 'EXTERNAL_ORIGIN' };
  }
  try {
    if (canonicalizeUrlOrigin(nextUrl.origin, 'origin') !== canonicalizeUrlOrigin(serviceUrl.origin, 'origin')) {
      return { ok: false, reason: 'EXTERNAL_ORIGIN' };
    }
  } catch {
    return { ok: false, reason: 'EXTERNAL_ORIGIN' };
  }
  const servicePath = serviceUrl.pathname.replace(/\/$/u, '');
  const nextPath = `${nextUrl.pathname}${nextUrl.search}`;
  if (servicePath && nextPath.startsWith(servicePath)) {
    const relative = nextPath.slice(servicePath.length);
    return { ok: true, path: relative.startsWith('/') ? relative : `/${relative}` };
  }
  return { ok: true, path: nextPath };
}

export async function serviceOriginFor(
  client: InventoryClient,
  service: HciServiceType,
  request: HciCollectionRequest | undefined,
): Promise<string | undefined> {
  const declared = request?.serviceOrigins?.[service];
  if (declared) return declared;
  if (typeof client.endpointFor !== 'function') return undefined;
  try {
    return await client.endpointFor(service);
  } catch {
    return undefined;
  }
}

export function wrapReadOnlyClient(
  client: InventoryClient,
  reads: HciReadRequestRecord[],
): InventoryClient {
  return {
    ...client,
    request: async (service, path, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method !== 'GET') {
        throw new Error('COLLECTION_MUTATION_REFUSED');
      }
      reads.push({ method: 'GET', service, path });
      return client.request(service, path, { ...init, method: 'GET' });
    },
  };
}

export function digestCollectionRevision(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(maskSecrets(value))).digest('hex');
}

export function fieldStatus(input: {
  id: string;
  availability: HciFieldAvailability;
  reason: string;
  collectionStatus: HciRequiredFieldStatus['collectionStatus'];
  sourceKind: HciRequiredFieldStatus['sourceKind'];
  importPath?: 'manual-provided';
  acquisition?: HciRequiredObservationAcquisition;
}): HciRequiredFieldStatus {
  return {
    id: input.id,
    availability: input.availability,
    reason: input.reason,
    collectionStatus: input.collectionStatus,
    sourceKind: input.sourceKind,
    ...(input.importPath ? { importPath: input.importPath } : {}),
    ...(input.acquisition ? { acquisition: input.acquisition } : {}),
  };
}

function surfaceField(
  id: HciInventoryCollectedSurface,
  status: { status: string; reason?: string },
  collected: boolean,
): HciRequiredFieldStatus {
  if (status.status === 'complete' && collected) {
    return fieldStatus({
      id,
      availability: 'collected',
      reason: 'REST surface returned a complete page set',
      collectionStatus: 'complete',
      sourceKind: 'unknown',
      acquisition: 'automatic',
    });
  }
  if (status.status === 'partial') {
    return fieldStatus({
      id,
      availability: 'collected',
      reason: status.reason ?? 'PARTIAL',
      collectionStatus: 'partial',
      sourceKind: 'unknown',
      acquisition: 'automatic',
    });
  }
  if (status.status === 'unsupported') {
    return fieldStatus({
      id,
      availability: 'missing',
      reason: status.reason ?? 'UNSUPPORTED',
      collectionStatus: 'unsupported',
      sourceKind: 'unknown',
      importPath: 'manual-provided',
      acquisition: 'unsupported',
    });
  }
  return fieldStatus({
    id,
    availability: 'missing',
    reason: status.reason ?? 'NOT_COLLECTED',
    collectionStatus: status.status === 'failed' ? 'failed' : 'missing',
    sourceKind: 'unknown',
    importPath: 'manual-provided',
    acquisition: 'unsupported',
  });
}

export function buildRequiredFieldStatuses(input: {
  collection: Record<HciInventoryCollectedSurface, { status: string; reason?: string }>;
  collectedAt?: string;
  firmwareVersion?: string;
  requested: readonly HciInventoryCollectedSurface[];
  providedFields?: HciCollectionOptions['providedFields'];
  attemptedRequiredReads?: HciCollectionOptions['attemptedRequiredReads'];
  requiredObservations?: HciRequiredObservationResult;
}): HciRequiredFieldStatus[] {
  const statuses: HciRequiredFieldStatus[] = [];
  for (const surface of HCI_INVENTORY_COLLECTED_SURFACES) {
    if (!input.requested.includes(surface)) {
      statuses.push(fieldStatus({
        id: surface,
        availability: 'missing',
        reason: 'SURFACE_NOT_REQUESTED',
        collectionStatus: 'missing',
        sourceKind: 'unknown',
        importPath: 'manual-provided',
        acquisition: 'unsupported',
      }));
      continue;
    }
    statuses.push(surfaceField(surface, input.collection[surface], true));
  }
  statuses.push(input.collectedAt
    ? fieldStatus({
      id: 'collectedAt',
      availability: 'collected',
      reason: 'Collection timestamp recorded for this run',
      collectionStatus: 'complete',
      sourceKind: 'unknown',
      acquisition: 'automatic',
    })
    : fieldStatus({
      id: 'collectedAt',
      availability: 'missing',
      reason: 'COLLECTION_TIME_UNPROVEN',
      collectionStatus: 'missing',
      sourceKind: 'unknown',
      acquisition: 'unsupported',
    }));
  statuses.push(input.collection.volumes.status === 'complete'
    ? fieldStatus({
      id: 'volume_status_health',
      availability: 'collected',
      reason: 'Volume list is complete enough for volume-status scope only',
      collectionStatus: 'complete',
      sourceKind: 'unknown',
      acquisition: 'automatic',
    })
    : fieldStatus({
      id: 'volume_status_health',
      availability: 'missing',
      reason: input.collection.volumes.reason ?? 'VOLUME_COLLECTION_INCOMPLETE',
      collectionStatus: input.collection.volumes.status === 'failed' ? 'failed' : 'missing',
      sourceKind: 'unknown',
      importPath: 'manual-provided',
      acquisition: 'unsupported',
    }));
  statuses.push(input.firmwareVersion
    ? fieldStatus({
      id: 'firmware',
      availability: 'provided',
      reason: 'Firmware was supplied on the collection request, not read from the device',
      collectionStatus: 'complete',
      sourceKind: 'provided',
      acquisition: 'manual-provided',
    })
    : fieldStatus({
      id: 'firmware',
      availability: 'missing',
      reason: 'FIRMWARE_NOT_COLLECTED',
      collectionStatus: 'unsupported',
      sourceKind: 'unknown',
      importPath: 'manual-provided',
      acquisition: 'unsupported',
    }));
  const required = input.requiredObservations ?? collectRequiredObservations({
    providedFields: input.providedFields,
    firmwareVersion: input.firmwareVersion,
    attemptedRequiredReads: input.attemptedRequiredReads,
  });
  for (const field of required.fields) {
    statuses.push(fieldStatus({
      id: field.id,
      availability: field.availability,
      reason: field.reason,
      collectionStatus: field.collectionStatus,
      sourceKind: field.sourceKind,
      importPath: field.importPath,
      acquisition: field.acquisition,
    }));
  }
  return statuses;
}

export function requiredObservationsFromOptions(opts: HciCollectionOptions): HciRequiredObservationResult {
  return collectRequiredObservations({
    providedFields: opts.providedFields,
    firmwareVersion: opts.firmwareVersion,
    attemptedRequiredReads: opts.attemptedRequiredReads,
  });
}

export function paginationLimits(request: HciCollectionRequest | undefined): { maxPages: number; maxPageTimeMs: number } {
  const maxPages = request?.maxPages ?? HCI_COLLECTION_DEFAULT_MAX_PAGES;
  const maxPageTimeMs = request?.maxPageTimeMs ?? HCI_COLLECTION_DEFAULT_MAX_PAGE_TIME_MS;
  return {
    maxPages: Number.isSafeInteger(maxPages) && maxPages > 0 ? Math.min(maxPages, 32) : HCI_COLLECTION_DEFAULT_MAX_PAGES,
    maxPageTimeMs: Number.isFinite(maxPageTimeMs) && maxPageTimeMs > 0
      ? Math.min(maxPageTimeMs, 60_000)
      : HCI_COLLECTION_DEFAULT_MAX_PAGE_TIME_MS,
  };
}

export function collectionOptionsRequest(opts: HciCollectionOptions): HciCollectionRequest | undefined {
  return opts.request;
}
