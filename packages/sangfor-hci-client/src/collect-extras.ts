import { ENGINEER_UNITS, type EngineerValue } from '../../shared/src/engineer-case-contract.js';
import { fieldStatus, type HciRequiredFieldStatus } from './collection.js';
import {
  HCI_COLLECTOR,
  HCI_MAPPER_VERSION,
  type HciFactProvenance,
} from './provenance.js';

/**
 * Extra grant surfaces that production collect emits only when the already-fetched
 * REST JSON contains an explicit key. Provenance is `unofficial_list_key:<id>`,
 * not a device URL or catalog path. Missing keys stay omitted / NOT_RUN. Values
 * are never invented from `opts.collectedAt`, `firmwareVersion`, volume status,
 * or provided E03B fields.
 */
export const HCI_COLLECT_EXTRA_SURFACE_IDS = [
  'collectedAt',
  'volume_status_health',
  'firmware',
  'host_cpu',
  'host_ram',
  'storage_usable_capacity',
  'network_topology',
  'ha_status',
] as const;

export type HciCollectExtraSurfaceId = (typeof HCI_COLLECT_EXTRA_SURFACE_IDS)[number];

export type HciInventoryOriginalPresentSurface = {
  readonly surfaceId: HciCollectExtraSurfaceId;
  readonly fact: HciFactProvenance;
  readonly originalPresent: true;
  readonly payload: unknown;
};

export type HciCollectExtraPage = {
  readonly endpoint: string;
  readonly payload: Record<string, unknown>;
  readonly latencyMs: number;
  readonly collectedAt: string;
};

const EXTRA_SURFACE_SET = new Set<string>(HCI_COLLECT_EXTRA_SURFACE_IDS);
const ENGINEER_UNIT_SET = new Set<string>(ENGINEER_UNITS);
const ISO_OFFSET_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isKnownEngineerValue(value: unknown): value is Extract<EngineerValue, { presence: 'known' }> {
  if (!isRecord(value) || value.presence !== 'known' || !isRecord(value.data)) return false;
  const data = value.data;
  if (data.kind === 'boolean') return typeof data.boolean === 'boolean';
  if (data.kind === 'string') return typeof data.text === 'string' && data.text.length > 0 && data.text.length <= 1024;
  if (data.kind === 'integer') {
    if (!Number.isInteger(data.integer) || !Number.isSafeInteger(data.integer)) return false;
    return data.unit === undefined || ENGINEER_UNIT_SET.has(String(data.unit));
  }
  if (data.kind === 'number') {
    return isFiniteNumber(data.number) && ENGINEER_UNIT_SET.has(String(data.unit));
  }
  return false;
}

function extraKindMatches(surfaceId: HciCollectExtraSurfaceId, value: Extract<EngineerValue, { presence: 'known' }>): boolean {
  const kind = value.data.kind;
  if (surfaceId === 'ha_status') return kind === 'boolean';
  if (surfaceId === 'network_topology') return kind === 'string';
  if (surfaceId === 'host_cpu' || surfaceId === 'host_ram' || surfaceId === 'storage_usable_capacity') {
    return kind === 'integer' || kind === 'number';
  }
  if (surfaceId === 'firmware') return kind === 'string';
  if (surfaceId === 'collectedAt') return kind === 'string';
  if (surfaceId === 'volume_status_health') return kind === 'string' || kind === 'boolean';
  return false;
}

function parseIsoDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !ISO_OFFSET_DATE.test(value)) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? value : undefined;
}

function parseFirmware(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 128) return undefined;
  return trimmed;
}

function parseVolumeStatusHealth(value: unknown): unknown | undefined {
  if (isKnownEngineerValue(value) && extraKindMatches('volume_status_health', value)) return value;
  if (!isRecord(value)) return undefined;
  const verdict = value.verdict;
  const scope = value.scope;
  if (
    (verdict === 'PASS' || verdict === 'FAIL' || verdict === 'INDETERMINATE')
    && scope === 'volume-status'
  ) {
    return { verdict, scope };
  }
  return undefined;
}

function parseE03bValue(surfaceId: HciCollectExtraSurfaceId, value: unknown): EngineerValue | undefined {
  if (!isKnownEngineerValue(value) || !extraKindMatches(surfaceId, value)) return undefined;
  return value;
}

function candidateFor(surfaceId: HciCollectExtraSurfaceId, raw: unknown): unknown | undefined {
  if (surfaceId === 'collectedAt') return parseIsoDate(raw);
  if (surfaceId === 'firmware') return parseFirmware(raw);
  if (surfaceId === 'volume_status_health') return parseVolumeStatusHealth(raw);
  return parseE03bValue(surfaceId, raw);
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * Official HCI OpenAPI/catalog read-only paths from data/hci-api/catalog.json.
 * Field-qualified lookalikes and GET /os-hypervisors are not catalog paths.
 */
export const OFFICIAL_HCI_CATALOG_READ_ENDPOINTS = [
  'GET /tenants',
  'GET /volumes',
  'GET /volumes/detail',
  'GET /volumes/{volume_id}',
  'GET /servers',
  'GET /servers/detail',
  'GET /servers/{id}',
  'GET /flavors',
  'GET /flavors/detail',
  'GET /v2/images',
] as const;

const OFFICIAL_HCI_CATALOG_READ_ENDPOINT_SET = new Set<string>(OFFICIAL_HCI_CATALOG_READ_ENDPOINTS);

/** Unofficial extra-key provenance. Not a device URL and not a catalog path. */
export const UNOFFICIAL_LIST_KEY_KIND = 'unofficial_list_key' as const;

const FIELD_QUALIFIED_DEVICE_ENDPOINT = /(?:^|\s)(?:GET|POST|PUT|PATCH|DELETE)\s+\S+\s+field:[A-Za-z0-9_-]+$/u;

export function unofficialListKeyEndpoint(surfaceId: HciCollectExtraSurfaceId): string {
  return `${UNOFFICIAL_LIST_KEY_KIND}:${surfaceId}`;
}

export function isOfficialHciCatalogReadEndpoint(endpoint: string): boolean {
  return OFFICIAL_HCI_CATALOG_READ_ENDPOINT_SET.has(endpoint.trim());
}

export function isFieldQualifiedDeviceEndpoint(endpoint: string): boolean {
  return FIELD_QUALIFIED_DEVICE_ENDPOINT.test(endpoint.trim());
}

function extraProvenance(
  page: HciCollectExtraPage,
  surfaceId: HciCollectExtraSurfaceId,
): HciFactProvenance {
  return {
    transport: 'api',
    endpoint: unofficialListKeyEndpoint(surfaceId),
    mapperVersion: HCI_MAPPER_VERSION,
    collectedAt: page.collectedAt,
    collector: HCI_COLLECTOR,
    ...(page.latencyMs > 0 ? { latencyMs: page.latencyMs } : {}),
  };
}

/**
 * Pull explicit extra keys off already-read REST JSON. Conflicting values
 * across pages are dropped. Guessed hypervisor/flavor/volume-status shapes
 * are not mapped.
 */
export function extractOriginalPresentSurfacesFromPages(
  pages: readonly HciCollectExtraPage[],
): readonly HciInventoryOriginalPresentSurface[] {
  const chosen = new Map<HciCollectExtraSurfaceId, { page: HciCollectExtraPage; payload: unknown }>();
  const conflicts = new Set<HciCollectExtraSurfaceId>();

  for (const page of pages) {
    for (const surfaceId of HCI_COLLECT_EXTRA_SURFACE_IDS) {
      if (!(surfaceId in page.payload)) continue;
      const parsed = candidateFor(surfaceId, page.payload[surfaceId]);
      if (parsed === undefined) continue;
      const prior = chosen.get(surfaceId);
      if (prior && stableJson(prior.payload) !== stableJson(parsed)) {
        conflicts.add(surfaceId);
        chosen.delete(surfaceId);
        continue;
      }
      if (!conflicts.has(surfaceId) && !prior) {
        chosen.set(surfaceId, { page, payload: parsed });
      }
    }
  }

  return HCI_COLLECT_EXTRA_SURFACE_IDS
    .filter((surfaceId) => chosen.has(surfaceId) && !conflicts.has(surfaceId))
    .map((surfaceId) => {
      const selected = chosen.get(surfaceId);
      if (!selected) throw new Error('collect extra selection invariant');
      return {
        surfaceId,
        originalPresent: true as const,
        fact: extraProvenance(selected.page, surfaceId),
        payload: selected.payload,
      };
    });
}

export function applyObservedExtrasToFields(
  fields: readonly HciRequiredFieldStatus[],
  extras: readonly HciInventoryOriginalPresentSurface[],
): readonly HciRequiredFieldStatus[] {
  if (extras.length === 0) return fields;
  const byId = new Map(extras.map((item) => [item.surfaceId, item]));
  return fields.map((field) => {
    if (!EXTRA_SURFACE_SET.has(field.id)) return field;
    const extra = byId.get(field.id as HciCollectExtraSurfaceId);
    if (!extra) return field;
    return fieldStatus({
      id: field.id,
      availability: 'collected',
      reason: `Device/API response contained ${field.id}`,
      collectionStatus: 'complete',
      sourceKind: 'observed',
      acquisition: 'automatic',
    });
  });
}

export function isHciCollectExtraSurfaceId(value: string): value is HciCollectExtraSurfaceId {
  return EXTRA_SURFACE_SET.has(value);
}
