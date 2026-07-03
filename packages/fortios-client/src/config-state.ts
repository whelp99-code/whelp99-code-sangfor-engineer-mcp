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
