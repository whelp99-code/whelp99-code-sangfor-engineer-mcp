// ConfigState extraction: captured authenticated-XHR pools → provenance-carrying
// observed maps for the advisory evaluator. Keys whose endpoint was not captured
// are OMITTED (they must surface as INDETERMINATE downstream, never as defaults).

import {
  MAPPER_VERSION,
  assertFactProvenance,
  type FactProvenance,
  type FactTransport,
} from './provenance.js';

export {
  MAPPER_VERSION,
  MissingProvenanceError,
  assertFactProvenance,
  isFactProvenance,
  type FactProvenance,
  type FactTransport,
} from './provenance.js';

/** An observed fact: the value plus the provenance envelope describing how it was
 *  obtained. The wrapper stays `{ value, source }` so @sangfor/spec keeps unwrapping it;
 *  `source` IS the envelope (endpoint/collectedAt/collector remain, transport and
 *  mapperVersion are added). */
export interface ObservedFactJson { value: unknown; source: FactProvenance; }

/** Build an observed fact. Fails closed: without a complete provenance envelope the
 *  fact is unauditable, so it is refused rather than stamped with defaults. */
export function createObservedFact(value: unknown, provenance: FactProvenance): ObservedFactJson {
  assertFactProvenance(provenance);
  return { value, source: provenance };
}

/** Collector-supplied envelope fields shared by both pool mappers. */
export interface PoolMapperOptions {
  collectedAt?: string;
  collector?: string;
  /** Captured XHR pools come off the console browser by default. */
  transport?: FactTransport;
  menuPath?: string[];
  firmwareVersion?: string;
  /** Measured collection latency; must be > 0 when supplied. */
  latencyMs?: number;
  authPrincipal?: string;
}

/** Validate the collector-supplied envelope fields once, before any fact is produced,
 *  so a bad envelope is refused even when the pool maps nothing. */
function assertMapperOptions(opts: PoolMapperOptions, collectedAt: string, collector: string): void {
  envelopeFor('POST /__envelope_precheck__', opts, collectedAt, collector);
}

function envelopeFor(endpoint: string, opts: PoolMapperOptions, collectedAt: string, collector: string): FactProvenance {
  const provenance: FactProvenance = {
    transport: opts.transport ?? 'browser',
    endpoint,
    mapperVersion: MAPPER_VERSION,
    collectedAt,
    collector,
    ...(opts.menuPath ? { menuPath: [...opts.menuPath] } : {}),
    ...(opts.firmwareVersion !== undefined ? { firmwareVersion: opts.firmwareVersion } : {}),
    ...(opts.latencyMs !== undefined ? { latencyMs: opts.latencyMs } : {}),
    ...(opts.authPrincipal !== undefined ? { authPrincipal: opts.authPrincipal } : {}),
  };
  assertFactProvenance(provenance);
  return provenance;
}

const EPP_PREFIX = 'POST /api/edrgoweb/v1/';

const EPP_KEYMAP: Array<{ key: string; endpoint?: string; full?: string; pick: (d: any) => unknown }> = [
  { key: 'patchIsLatest', endpoint: 'patch/statistics', pick: (d) => d?.isLatest },
  { key: 'vulnDefUpdateAvailable', endpoint: 'vulner/list/version', pick: (d) => d?.update },
  { key: 'vulnerabilityCount', endpoint: 'vulner/list/homepageVulner', pick: (d) => d?.vulnerCount },
  { key: 'securityBaselineRuleCount', endpoint: 'baseline/getRule', pick: (d) => d?.count },
  { key: 'maliciousDomainBlockCount', endpoint: 'domain_detect/get_domain_info', pick: (d) => d?.count },
  { key: 'maliciousDomainDetectionActive', endpoint: 'domain_detect/get_domain_info', pick: (d) => (typeof d?.isDetected === 'boolean' ? d.isDetected : undefined) },
  { key: 'assetInventoryClassifiedCount', endpoint: 'asset/inventory/classify', pick: (d) => (Array.isArray(d) ? d.length : undefined) },
  { key: 'darMonitoringActive', endpoint: 'cnapp/professional/dar/webapi/interval/status', pick: (d) => (d?.interval != null) },
  { key: 'deviceControlConfigured', endpoint: 'control/queryctrlapppolicy', pick: (d) => ((d?.totalCount ?? 0) > 0) },
  { key: 'agentAutoUpdateEnabled', full: 'POST /launch.php?opr=get_upgrade_state', pick: (d) => (typeof d?.download_enable === 'boolean' ? d.download_enable : undefined) },
  { key: 'quarantineConfigured', full: 'POST /launch.php?opr=list_policy_safe_area', pick: (d) => (d?.safe_area?.isolate_area != null) },
  { key: 'edrBehaviorMonitoringEnabled', full: 'POST /launch.php?opr=list_policy_extortion_protection', pick: (d) => (d?.safe_fasten?.ransom_killer?.enable === 1) },
  { key: 'exclusionListManaged', full: 'POST /launch.php?opr=list_policy_trust_path', pick: (d) => (d?.trust_list != null && Object.keys(d.trust_list).length > 0) },
];

export function mapEppPoolToConfigState(
  pool: Record<string, any>,
  opts: PoolMapperOptions = {},
): { product: 'EPP'; observed: Record<string, ObservedFactJson>; endpointsCaptured: number; mappedKeys: string[]; unmappedNote: string } {
  const collectedAt = opts.collectedAt ?? new Date().toISOString();
  const collector = opts.collector ?? 'live-xhr-pool';
  assertMapperOptions(opts, collectedAt, collector);
  const observed: Record<string, ObservedFactJson> = {};
  for (const { key, endpoint, full: fullEndpoint, pick } of EPP_KEYMAP) {
    const full = fullEndpoint ?? `${EPP_PREFIX}${endpoint}`;
    if (!(full in pool)) continue; // uncaptured → omitted → INDETERMINATE downstream
    const value = pick(pool[full]);
    if (value === undefined) continue;
    observed[key] = createObservedFact(value, envelopeFor(full, opts, collectedAt, collector));
  }
  return {
    product: 'EPP',
    observed,
    endpointsCaptured: Object.keys(pool).length,
    mappedKeys: Object.keys(observed),
    unmappedNote: 'keys without a captured endpoint are omitted on purpose; the evaluator must treat them as INDETERMINATE',
  };
}

const CC_KEYMAP: Array<{ key: string; endpoint: string; pick: (d: any) => unknown }> = [
  { key: 'systemVersion', endpoint: 'POST /apps/secvisual/system/system_manage/get_system_info', pick: (d) => d?.system_version },
  { key: 'timezone', endpoint: 'POST /apps/secvisual/system/system_manage/get_system_info', pick: (d) => d?.timezone },
  { key: 'isVersionExpired', endpoint: 'POST /apps/secvisual/system/system_manage/get_system_info', pick: (d) => d?.is_version_expired },
  { key: 'isCertExpired', endpoint: 'POST /apps/secvisual/system/system_manage/get_system_info', pick: (d) => d?.is_cert_expired },
  { key: 'virusLibExists', endpoint: 'POST /apps/secvisual/system/system_manage/get_system_info', pick: (d) => d?.lib_info?.is_virus_lib_exist },
  { key: 'clusterMasterOffline', endpoint: 'POST /api/v1/clusters/master', pick: (d) => d?.offline },
  { key: 'clusterModeEnabled', endpoint: 'POST /api/v1/clusters/status/mgr', pick: (d) => d?.mode },
  { key: 'linkWorkOrderEnabled', endpoint: 'POST /apps/secvisual/link_work_order/Link_work_order/on_config_list', pick: (d) => d?.enable },
  { key: 'linkWorkOrderPort', endpoint: 'POST /apps/secvisual/link_work_order/Link_work_order/on_config_list', pick: (d) => d?.port },
  { key: 'alarmTuningConfigured', endpoint: 'POST /apps/secvisual/alarm/alarm_policy/on_list', pick: (d) => Array.isArray(d) && d.length > 0 },
  { key: 'scheduledReportConfigured', endpoint: 'POST /apps/secvisual/home/home/get_report_tag', pick: (d) => d?.reports != null },
  { key: 'alertChannelConfigured', endpoint: 'POST /apps/secvisual/alarm/alarm_policy/on_list', pick: (d) => Array.isArray(d) && d.some((p: any) => p.mail_on || p.sms_on || (Array.isArray(p.mail_to) && p.mail_to.length > 0)) },
];

export function mapCcPoolToConfigState(
  pool: Record<string, any>,
  opts: PoolMapperOptions = {},
): { product: 'CC'; observed: Record<string, ObservedFactJson>; endpointsCaptured: number; mappedKeys: string[]; unmappedNote: string } {
  const collectedAt = opts.collectedAt ?? new Date().toISOString();
  const collector = opts.collector ?? 'live-xhr-pool';
  assertMapperOptions(opts, collectedAt, collector);
  const observed: Record<string, ObservedFactJson> = {};
  for (const { key, endpoint, pick } of CC_KEYMAP) {
    if (!(endpoint in pool)) continue; // uncaptured → omitted
    const value = pick(pool[endpoint]);
    if (value === undefined) continue;
    observed[key] = createObservedFact(value, envelopeFor(endpoint, opts, collectedAt, collector));
  }
  return {
    product: 'CC',
    observed,
    endpointsCaptured: Object.keys(pool).length,
    mappedKeys: Object.keys(observed),
    unmappedNote: 'keys without a captured endpoint are omitted on purpose; the evaluator must treat them as INDETERMINATE',
  };
}
