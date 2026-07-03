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
