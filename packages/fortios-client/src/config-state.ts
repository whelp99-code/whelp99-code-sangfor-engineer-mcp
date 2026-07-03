export interface ConfigStateItem {
  observedKey: string;
  value: unknown;
  source: 'api' | 'mock';
}

/**
 * Map FortiOS REST API responses to config-state items.
 * API response: { results: [...] } or { data: {...} }
 * Returns array of items with observedKey matching spec items.
 */
export function mapFortiOSConfigState(apiResponse: any, source: 'api' | 'mock' = 'api'): ConfigStateItem[] {
  const items: ConfigStateItem[] = [];

  // Map policy count (GET /api/v2/firewall/policy -> { results: [...] })
  if (apiResponse.results && Array.isArray(apiResponse.results)) {
    items.push({
      observedKey: 'policyCount',
      value: apiResponse.results.length,
      source,
    });
  }

  // Map SSL inspection (check if any policy has sslvpnprofile or ssl-ssh-profile)
  if (apiResponse.results && Array.isArray(apiResponse.results)) {
    const sslInspectionEnabled = apiResponse.results.some((p: any) =>
      p['ssl-ssh-profile'] || p.sslvpnprofile
    );
    items.push({
      observedKey: 'sslInspectionEnabled',
      value: sslInspectionEnabled,
      source,
    });
  }

  // Map threat logging (check any policy logtraffic field)
  if (apiResponse.results && Array.isArray(apiResponse.results)) {
    const threatLoggingEnabled = apiResponse.results.some((p: any) =>
      p.logtraffic === 'all' || p.logtraffic === 'utm'
    );
    items.push({
      observedKey: 'threatLoggingEnabled',
      value: threatLoggingEnabled,
      source,
    });
  }

  // Map WAN interface count (GET /api/v2/system/interface -> { results: [...] })
  if (apiResponse.results && Array.isArray(apiResponse.results)) {
    const wanCount = apiResponse.results.filter((iface: any) =>
      iface.type === 'physical' && (iface.name?.startsWith('port') || iface.name?.startsWith('wan'))
    ).length;
    items.push({
      observedKey: 'wanInterfaceCount',
      value: wanCount,
      source,
    });
  }

  return items;
}

/**
 * Map FortiOS system health metrics (CPU, memory, disk, ASIC load, HA status)
 * Consumes: /api/v2/monitor/system/status, /api/v2/monitor/system/npu-stats, /api/v2/cmdb/system/ha-setting
 */
export function mapFortiOSSystemHealth(
  statusResponse: any,
  npuResponse: any,
  haResponse: any,
  source: 'api' | 'mock' = 'api'
): ConfigStateItem[] {
  const items: ConfigStateItem[] = [];

  // CPU usage from status (single value for system)
  if (statusResponse?.results?.[0]?.cpu) {
    items.push({
      observedKey: 'systemCpuUsage',
      value: statusResponse.results[0].cpu,
      source,
    });
  }

  // Memory usage
  if (statusResponse?.results?.[0]?.mem) {
    items.push({
      observedKey: 'systemMemoryUsage',
      value: statusResponse.results[0].mem,
      source,
    });
  }

  // Disk usage
  if (statusResponse?.results?.[0]?.disk) {
    items.push({
      observedKey: 'systemDiskUsage',
      value: statusResponse.results[0].disk,
      source,
    });
  }

  // ASIC (NP7) CPU usage from npu-stats
  if (npuResponse?.results?.[0]?.cpu) {
    items.push({
      observedKey: 'npuCpuUsage',
      value: npuResponse.results[0].cpu,
      source,
    });
  }

  // HA mode (a-p for active-passive, a-a for active-active, standalone)
  if (haResponse?.results?.[0]?.mode) {
    items.push({
      observedKey: 'haMode',
      value: haResponse.results[0].mode === 'a-p' ? 'active-passive' :
             haResponse.results[0].mode === 'a-a' ? 'active-active' : 'standalone',
      source,
    });
  }

  // HA primary unit (state === 'master')
  if (haResponse?.results?.[0]?.state) {
    items.push({
      observedKey: 'haPrimaryUnit',
      value: haResponse.results[0].state === 'master',
      source,
    });
  }

  return items;
}

/**
 * Map FortiOS policy audit (syntax validity, duplicates, IPS signature version)
 * Consumes: /api/v2/cmdb/firewall/policy, /api/v2/cmdb/ips/sensor
 */
export function mapFortiOSPolicyAudit(
  policyResponse: any,
  ipsResponse: any,
  source: 'api' | 'mock' = 'api'
): ConfigStateItem[] {
  const items: ConfigStateItem[] = [];

  // Policy syntax validation: check for required fields (action, srcintf, dstintf)
  if (policyResponse?.results && Array.isArray(policyResponse.results)) {
    const allValid = policyResponse.results.every((p: any) =>
      p.action && p.srcintf && p.dstintf
    );
    items.push({
      observedKey: 'policySyntaxValid',
      value: allValid,
      source,
    });

    // Count duplicate policies (same source + destination + action)
    const policySignatures = policyResponse.results.map((p: any) =>
      `${p.srcintf}-${p.dstintf}-${p.action}`
    );
    const duplicateCount = policySignatures.length - new Set(policySignatures).size;
    items.push({
      observedKey: 'policyDuplicateCount',
      value: duplicateCount,
      source,
    });
  }

  // IPS signature version
  if (ipsResponse?.results?.[0]?.signature_database) {
    items.push({
      observedKey: 'ipsSignatureVersion',
      value: ipsResponse.results[0].signature_database,
      source,
    });
  }

  return items;
}
