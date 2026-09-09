import type { EngineerValue } from '../../shared/src/engineer-case-contract.js';

/** E03B required observation surfaces that E03A does not collect.
 *
 * Host CPU/RAM, usable storage, network topology, and HA are selected from the
 * E00 existing-hci-health gap list. This module defines support metadata and
 * binds provided values. It does not invent REST paths, selectors, or numeric
 * defaults. Automatic collection stays unsupported until an official response
 * or captured read-screen is in-repo.
 */

export const HCI_E03B_REQUIRED_FIELDS = [
  'host_cpu',
  'host_ram',
  'storage_usable_capacity',
  'network_topology',
  'ha_status',
] as const;

export type HciE03bFieldId = (typeof HCI_E03B_REQUIRED_FIELDS)[number];

export type HciRequiredObservationAcquisition = 'automatic' | 'manual-provided' | 'unsupported';

export type HciProvidedFieldInput = EngineerValue;
export type HciRequiredFieldValue = EngineerValue;

export type HciRequiredReadAttempt = {
  readonly endpoint: string;
  readonly status?: number;
  readonly payload?: unknown;
  readonly fieldId?: HciE03bFieldId;
};

export type HciRequiredObservationCapability = {
  readonly id: string;
  readonly fieldId: HciE03bFieldId;
  readonly title: string;
  readonly support: 'unsupported';
  readonly transport: 'none';
  readonly surfaces: readonly [];
  readonly firmwareSupport: 'unknown';
  readonly firmwareSupportReason: string;
  readonly collectionPath: null;
  readonly catalogClaim: string | null;
  readonly permission: string;
  readonly evidence: string;
  readonly completeness: 'unsupported';
  readonly acquisition: 'manual-provided';
  readonly fieldAcceptanceBlockerResolved: false;
  readonly unsupportedReason: string;
};

export type HciRequiredFieldView = {
  readonly id: HciE03bFieldId;
  readonly availability: 'provided' | 'missing';
  readonly reason: string;
  readonly collectionStatus: 'complete' | 'missing' | 'failed' | 'unsupported';
  readonly sourceKind: 'provided' | 'unknown';
  readonly importPath?: 'manual-provided';
  readonly acquisition: HciRequiredObservationAcquisition;
  readonly firmwareSupport: 'unknown';
  readonly collectionPath: null;
  readonly permission: string;
  readonly evidence: string;
  readonly completeness: 'complete' | 'unsupported';
  readonly fieldAcceptanceBlockerResolved: false;
  readonly value: HciRequiredFieldValue;
};

export type HciRequiredObservationResult = {
  readonly fields: readonly HciRequiredFieldView[];
  readonly capabilities: readonly HciRequiredObservationCapability[];
  readonly acquisition: Readonly<Record<HciE03bFieldId, HciRequiredObservationAcquisition>>;
  readonly guideReadyGranted: false;
  readonly fieldAcceptanceBlockersResolved: false;
  readonly mutationDispatchCount: 0;
  readonly persisted: false;
};

const FIRMWARE_SUPPORT_REASON =
  'No official HCI OpenAPI host/network/HA response is captured in-repo, so no firmware can be marked supported.';

export const HCI_E03B_CAPABILITIES: readonly HciRequiredObservationCapability[] = [
  {
    id: 'hci.collect.host_cpu',
    fieldId: 'host_cpu',
    title: 'Host CPU collection',
    support: 'unsupported',
    transport: 'none',
    surfaces: [],
    firmwareSupport: 'unknown',
    firmwareSupportReason: FIRMWARE_SUPPORT_REASON,
    collectionPath: null,
    catalogClaim: 'GET /janus/20180725/hosts (SCP Open-API v6.10.0; capture_gated; not Keystone)',
    permission: 'unverified; no evidenced host-CPU read adapter',
    evidence: 'Official Janus hosts list documents cpu.core_count. Live GET stays capture_gated. Keystone collect has no host-CPU path. GET /os-hypervisors is forged.',
    completeness: 'unsupported',
    acquisition: 'manual-provided',
    fieldAcceptanceBlockerResolved: false,
    unsupportedReason: 'NO_OFFICIAL_HOST_CPU_API',
  },
  {
    id: 'hci.collect.host_ram',
    fieldId: 'host_ram',
    title: 'Host RAM collection',
    support: 'unsupported',
    transport: 'none',
    surfaces: [],
    firmwareSupport: 'unknown',
    firmwareSupportReason: FIRMWARE_SUPPORT_REASON,
    collectionPath: null,
    catalogClaim: 'GET /janus/20180725/hosts (SCP Open-API v6.10.0; capture_gated; not Keystone)',
    permission: 'unverified; no evidenced host-RAM read adapter',
    evidence: 'Official Janus hosts list documents memory.total_mb. Live GET stays capture_gated. Keystone collect has no host-RAM path. GET /os-hypervisors is forged.',
    completeness: 'unsupported',
    acquisition: 'manual-provided',
    fieldAcceptanceBlockerResolved: false,
    unsupportedReason: 'NO_OFFICIAL_HOST_RAM_API',
  },
  {
    id: 'hci.collect.storage_usable',
    fieldId: 'storage_usable_capacity',
    title: 'Usable storage capacity collection',
    support: 'unsupported',
    transport: 'none',
    surfaces: [],
    firmwareSupport: 'unknown',
    firmwareSupportReason: FIRMWARE_SUPPORT_REASON,
    collectionPath: null,
    catalogClaim: null,
    permission: 'unverified; volume size is not usable cluster capacity',
    evidence: 'Volume size is provisioned volume size. Historical volume service was unavailable. Summing sizes would fabricate usable capacity.',
    completeness: 'unsupported',
    acquisition: 'manual-provided',
    fieldAcceptanceBlockerResolved: false,
    unsupportedReason: 'VOLUME_SIZE_IS_NOT_USABLE_CAPACITY',
  },
  {
    id: 'hci.collect.network_topology',
    fieldId: 'network_topology',
    title: 'Network topology collection',
    support: 'unsupported',
    transport: 'none',
    surfaces: [],
    firmwareSupport: 'unknown',
    firmwareSupportReason: FIRMWARE_SUPPORT_REASON,
    collectionPath: null,
    catalogClaim: 'GET /openstack/network/v2.0/networks (product-catalog claim only)',
    permission: 'unverified; network service is not in the HCI client catalog types',
    evidence: 'Catalog string exists; HciServiceType has no network; mock catalog has no neutron; no historical live network collection',
    completeness: 'unsupported',
    acquisition: 'manual-provided',
    fieldAcceptanceBlockerResolved: false,
    unsupportedReason: 'NETWORK_SERVICE_UNVERIFIED',
  },
  {
    id: 'hci.collect.ha_status',
    fieldId: 'ha_status',
    title: 'HA/DRS status collection',
    support: 'unsupported',
    transport: 'none',
    surfaces: [],
    firmwareSupport: 'unknown',
    firmwareSupportReason: FIRMWARE_SUPPORT_REASON,
    collectionPath: null,
    catalogClaim: 'WebUI Reliability > HA (menu claim only; no verified selector)',
    permission: 'unverified; no evidenced HA read adapter',
    evidence: 'No official HA read API or captured DOM selector. Browser transport would need a child Issue.',
    completeness: 'unsupported',
    acquisition: 'manual-provided',
    fieldAcceptanceBlockerResolved: false,
    unsupportedReason: 'NO_OFFICIAL_HA_READ_API',
  },
];

const CAPABILITY_BY_FIELD = Object.fromEntries(
  HCI_E03B_CAPABILITIES.map((row) => [row.fieldId, row]),
) as Record<HciE03bFieldId, HciRequiredObservationCapability>;

/** E03A REST surfaces are the only evidenced automatic collection paths. */
const EVIDENCED_AUTOMATIC_ENDPOINTS = new Set([
  'GET /volumes/detail',
  'GET /servers',
  'GET /v2/images',
]);

export function isProtocolRelativeHref(value: string): boolean {
  return value.trim().startsWith('//');
}

function endpointHref(endpoint: string): string {
  return endpoint.trim().replace(/^[A-Z]+\s+/u, '');
}

export function classifyRequiredReadAttempt(
  attempt: HciRequiredReadAttempt,
  opts: { firmwareVersion?: string } = {},
): 'EXTERNAL_ORIGIN' | 'FORGED_ENDPOINT' | 'UNSUPPORTED_FIRMWARE' | 'AUTH_FAILED' | 'SCHEMA_CHANGED' {
  const endpoint = attempt.endpoint.trim();
  const href = endpointHref(endpoint);
  if (!endpoint || isProtocolRelativeHref(endpoint) || isProtocolRelativeHref(href)) return 'EXTERNAL_ORIGIN';
  try {
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(href)) return 'EXTERNAL_ORIGIN';
  } catch {
    return 'FORGED_ENDPOINT';
  }
  if (EVIDENCED_AUTOMATIC_ENDPOINTS.has(endpoint)) {
    return 'FORGED_ENDPOINT';
  }
  if (opts.firmwareVersion) return 'UNSUPPORTED_FIRMWARE';
  if (attempt.status === 401 || attempt.status === 403) return 'AUTH_FAILED';
  if (attempt.payload !== undefined) return 'SCHEMA_CHANGED';
  return 'FORGED_ENDPOINT';
}

/** Invented hypervisor/network/HA payloads are never mapped to numeric or boolean facts. */
export function mapRequiredFieldFromApiPayload(
  fieldId: HciE03bFieldId,
  payload: unknown,
): { readonly mapped: false; readonly reason: string; readonly value: HciRequiredFieldValue } {
  const capability = CAPABILITY_BY_FIELD[fieldId];
  void payload;
  return {
    mapped: false,
    reason: capability.unsupportedReason,
    value: { presence: 'unknown', reason: capability.unsupportedReason },
  };
}

function pickAttemptReason(reasons: readonly string[]): string | undefined {
  if (reasons.includes('EXTERNAL_ORIGIN')) return 'EXTERNAL_ORIGIN';
  if (reasons.includes('FORGED_ENDPOINT')) return 'FORGED_ENDPOINT';
  if (reasons.includes('UNSUPPORTED_FIRMWARE')) return 'UNSUPPORTED_FIRMWARE';
  if (reasons.includes('AUTH_FAILED')) return 'AUTH_FAILED';
  if (reasons.includes('SCHEMA_CHANGED')) return 'SCHEMA_CHANGED';
  return reasons[0];
}

function attemptReasonForField(
  fieldId: HciE03bFieldId,
  attempts: readonly HciRequiredReadAttempt[] | undefined,
  firmwareVersion: string | undefined,
): string | undefined {
  if (!attempts || attempts.length === 0) return undefined;
  const scoped = attempts.filter((attempt) => attempt.fieldId === fieldId || attempt.fieldId === undefined);
  if (scoped.length === 0) return undefined;
  return pickAttemptReason(scoped.map((attempt) => classifyRequiredReadAttempt(attempt, { firmwareVersion })));
}

function providedReason(value: HciProvidedFieldInput, capability: HciRequiredObservationCapability): string {
  if (value.presence === 'unknown') return value.reason;
  return `MANUAL_PROVIDED:${capability.fieldId}`;
}

export function collectRequiredObservations(input: {
  readonly providedFields?: Partial<Record<HciE03bFieldId, HciProvidedFieldInput>>;
  readonly firmwareVersion?: string;
  readonly attemptedRequiredReads?: readonly HciRequiredReadAttempt[];
} = {}): HciRequiredObservationResult {
  const fields = HCI_E03B_REQUIRED_FIELDS.map((fieldId) => {
    const capability = CAPABILITY_BY_FIELD[fieldId];
    const provided = input.providedFields?.[fieldId];
    const attempt = attemptReasonForField(fieldId, input.attemptedRequiredReads, input.firmwareVersion);
    if (provided?.presence !== 'known' && attempt) {
      return {
        id: fieldId,
        availability: 'missing' as const,
        reason: attempt,
        collectionStatus: attempt === 'AUTH_FAILED' || attempt === 'SCHEMA_CHANGED' ? 'failed' as const : 'unsupported' as const,
        sourceKind: 'unknown' as const,
        importPath: 'manual-provided' as const,
        acquisition: 'unsupported' as const,
        firmwareSupport: 'unknown' as const,
        collectionPath: null,
        permission: capability.permission,
        evidence: capability.evidence,
        completeness: 'unsupported' as const,
        fieldAcceptanceBlockerResolved: false as const,
        value: { presence: 'unknown' as const, reason: attempt },
      };
    }
    if (provided?.presence === 'known') {
      return {
        id: fieldId,
        availability: 'provided' as const,
        reason: providedReason(provided, capability),
        collectionStatus: 'complete' as const,
        sourceKind: 'provided' as const,
        importPath: 'manual-provided' as const,
        acquisition: 'manual-provided' as const,
        firmwareSupport: 'unknown' as const,
        collectionPath: null,
        permission: capability.permission,
        evidence: capability.evidence,
        completeness: 'complete' as const,
        fieldAcceptanceBlockerResolved: false as const,
        value: provided,
      };
    }
    const missingReason = provided?.presence === 'unknown' ? provided.reason : capability.unsupportedReason;
    return {
      id: fieldId,
      availability: 'missing' as const,
      reason: missingReason,
      collectionStatus: 'unsupported' as const,
      sourceKind: 'unknown' as const,
      importPath: 'manual-provided' as const,
      acquisition: 'unsupported' as const,
      firmwareSupport: 'unknown' as const,
      collectionPath: null,
      permission: capability.permission,
      evidence: capability.evidence,
      completeness: 'unsupported' as const,
      fieldAcceptanceBlockerResolved: false as const,
      value: { presence: 'unknown' as const, reason: missingReason },
    };
  });

  return {
    fields,
    capabilities: HCI_E03B_CAPABILITIES,
    acquisition: Object.fromEntries(fields.map((field) => [field.id, field.acquisition])) as Record<
      HciE03bFieldId,
      HciRequiredObservationAcquisition
    >,
    guideReadyGranted: false,
    fieldAcceptanceBlockersResolved: false,
    mutationDispatchCount: 0,
    persisted: false,
  };
}
