export interface ConfigStateItem {
  observedKey: string;
  value: unknown;
  source: 'api' | 'mock';
}

/**
 * Map Cisco RESTCONF API responses to config-state items.
 * RESTCONF path: /restconf/data/ietf-interfaces:interfaces/interface
 * Response: { "ietf-interfaces:interface": [...] }
 */
export function mapCiscoConfigState(apiResponse: any, source: 'api' | 'mock' = 'api'): ConfigStateItem[] {
  const items: ConfigStateItem[] = [];

  // Extract interfaces array from RESTCONF response
  const interfaces = apiResponse['ietf-interfaces:interface'] || apiResponse.interface || [];

  // Map total interface count
  items.push({
    observedKey: 'interfaceCount',
    value: interfaces.length,
    source,
  });

  // Map loopback interface count
  const loopbackCount = interfaces.filter((iface: any) =>
    iface.name?.startsWith('Loopback')
  ).length;
  items.push({
    observedKey: 'loopbackCount',
    value: loopbackCount,
    source,
  });

  // Extract routing info (assuming separate RESTCONF call)
  if (apiResponse['ietf-routing:routing']) {
    const routing = apiResponse['ietf-routing:routing'];
    const staticRoutes = routing['static-routes']?.['static'] || [];
    items.push({
      observedKey: 'staticRouteCount',
      value: Array.isArray(staticRoutes) ? staticRoutes.length : 0,
      source,
    });

    // Check OSPF enabled (presence of ospf process)
    const ospfEnabled = !!(routing['control-plane-protocols']?.['control-plane-protocol']?.some(
      (cp: any) => cp.type === 'ospf'
    ));
    items.push({
      observedKey: 'ospfEnabled',
      value: ospfEnabled,
      source,
    });
  }

  return items;
}

/**
 * Map Cisco system health (per-core CPU average, memory, interface status, VRF count)
 */
export function mapCiscoSystemHealth(
  cpuResponse: any,
  memoryResponse: any,
  interfacesResponse: any,
  vrfResponse: any,
  source: 'api' | 'mock' = 'api'
): ConfigStateItem[] {
  const items: ConfigStateItem[] = [];

  // CPU usage (average of all cores)
  if (cpuResponse?.['Cisco-IOS-XE-utilization:system']?.['cpu-utilization']) {
    const cpuData = cpuResponse['Cisco-IOS-XE-utilization:system']['cpu-utilization'];
    const coreUsages = (cpuData['cpu-core'] || [])
      .map((core: any) => parseFloat(core['cpu-utilization']))
      .filter((v: number) => !isNaN(v));
    const avgUsage = coreUsages.length > 0
      ? Math.round(coreUsages.reduce((a: number, b: number) => a + b, 0) / coreUsages.length)
      : 0;
    items.push({
      observedKey: 'systemCpuUsageAverage',
      value: avgUsage,
      source,
    });
  }

  // Memory usage
  if (memoryResponse?.['Cisco-IOS-XE-memory:memory']?.['memory-statistics']) {
    const memStats = memoryResponse['Cisco-IOS-XE-memory:memory']['memory-statistics'];
    const memUsagePercent = memStats.used && memStats.total
      ? Math.round((memStats.used / memStats.total) * 100)
      : 0;
    items.push({
      observedKey: 'systemMemoryUsage',
      value: memUsagePercent,
      source,
    });
  }

  // Interface down count
  if (interfacesResponse?.['ietf-interfaces:interfaces-state']) {
    const interfaces = interfacesResponse['ietf-interfaces:interfaces-state'].interface || [];
    const downCount = interfaces.filter((iface: any) => iface['oper-status'] === 'down').length;
    items.push({
      observedKey: 'interfaceDownCount',
      value: downCount,
      source,
    });
  }

  // VRF count
  if (vrfResponse?.['ietf-routing:routing']?.['control-plane-protocols']) {
    const protocols = vrfResponse['ietf-routing:routing']['control-plane-protocols']['control-plane-protocol'] || [];
    const vrfs = new Set(protocols.map((p: any) => p['vrf-name'] || 'default'));
    items.push({
      observedKey: 'vrfCount',
      value: vrfs.size,
      source,
    });
  }

  return items;
}

/**
 * Map Cisco policy audit (zone-pair policies, ACL rules, SNORT status)
 */
export function mapCiscoPolicyAudit(
  zonePolicyResponse: any,
  aclResponse: any,
  snortResponse: any,
  source: 'api' | 'mock' = 'api'
): ConfigStateItem[] {
  const items: ConfigStateItem[] = [];

  // Zone-pair policy count
  if (zonePolicyResponse?.['Cisco-IOS-XE-zone-based-firewall:zone-pair']) {
    const zonePairs = zonePolicyResponse['Cisco-IOS-XE-zone-based-firewall:zone-pair'];
    items.push({
      observedKey: 'zonePairPolicyCount',
      value: Array.isArray(zonePairs) ? zonePairs.length : (zonePairs ? 1 : 0),
      source,
    });
  }

  // ACL rule count
  if (aclResponse?.['Cisco-IOS-XE-acl:ip']?.['access-lists']) {
    const acls = aclResponse['Cisco-IOS-XE-acl:ip']['access-lists']['access-list'] || [];
    const totalRules = acls.reduce((sum: number, acl: any) =>
      sum + ((acl['access-list-entries']?.['access-list-entry'] || []).length), 0);
    items.push({
      observedKey: 'aclRuleCount',
      value: totalRules,
      source,
    });
  }

  // SNORT signature version
  if (snortResponse?.['Cisco-IOS-XE-snort:snort']?.['snort-config']) {
    items.push({
      observedKey: 'snortSignatureVersion',
      value: snortResponse['Cisco-IOS-XE-snort:snort']['snort-config']['rule-database-version'] || 'unknown',
      source,
    });
  }

  // SNORT inspection enabled
  if (snortResponse?.['Cisco-IOS-XE-snort:snort']?.['snort-config']) {
    const snortConfig = snortResponse['Cisco-IOS-XE-snort:snort']['snort-config'];
    items.push({
      observedKey: 'snortInspectionEnabled',
      value: snortConfig.enabled === true,
      source,
    });
  }

  return items;
}
