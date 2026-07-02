// ConfigState extraction: captured authenticated-XHR pools → provenance-carrying
// observed maps for the advisory evaluator. Keys whose endpoint was not captured
// are OMITTED (they must surface as INDETERMINATE downstream, never as defaults).

export interface ObservedFactJson { value: unknown; source: { endpoint: string; collectedAt: string; collector: string }; }

const EPP_PREFIX = 'POST /api/edrgoweb/v1/';

const EPP_KEYMAP: Array<{ key: string; endpoint: string; pick: (d: any) => unknown }> = [
  { key: 'patchIsLatest', endpoint: 'patch/statistics', pick: (d) => d?.isLatest },
  { key: 'vulnDefUpdateAvailable', endpoint: 'vulner/list/version', pick: (d) => d?.update },
  { key: 'vulnerabilityCount', endpoint: 'vulner/list/homepageVulner', pick: (d) => d?.vulnerCount },
  { key: 'securityBaselineRuleCount', endpoint: 'baseline/getRule', pick: (d) => d?.count },
  { key: 'maliciousDomainBlockCount', endpoint: 'domain_detect/get_domain_info', pick: (d) => d?.count },
  { key: 'maliciousDomainDetectionActive', endpoint: 'domain_detect/get_domain_info', pick: (d) => (typeof d?.isDetected === 'boolean' ? d.isDetected : undefined) },
  { key: 'assetInventoryClassifiedCount', endpoint: 'asset/inventory/classify', pick: (d) => (Array.isArray(d) ? d.length : undefined) },
  { key: 'darMonitoringActive', endpoint: 'cnapp/professional/dar/webapi/interval/status', pick: (d) => (d?.interval != null) },
];

export function mapEppPoolToConfigState(
  pool: Record<string, any>,
  opts: { collectedAt?: string; collector?: string } = {},
): { product: 'EPP'; observed: Record<string, ObservedFactJson>; endpointsCaptured: number; mappedKeys: string[]; unmappedNote: string } {
  const collectedAt = opts.collectedAt ?? new Date().toISOString();
  const collector = opts.collector ?? 'live-xhr-pool';
  const observed: Record<string, ObservedFactJson> = {};
  for (const { key, endpoint, pick } of EPP_KEYMAP) {
    const full = `${EPP_PREFIX}${endpoint}`;
    if (!(full in pool)) continue; // uncaptured → omitted → INDETERMINATE downstream
    const value = pick(pool[full]);
    if (value === undefined) continue;
    observed[key] = { value, source: { endpoint: full, collectedAt, collector } };
  }
  return {
    product: 'EPP',
    observed,
    endpointsCaptured: Object.keys(pool).length,
    mappedKeys: Object.keys(observed),
    unmappedNote: 'keys without a captured endpoint are omitted on purpose; the evaluator must treat them as INDETERMINATE',
  };
}
