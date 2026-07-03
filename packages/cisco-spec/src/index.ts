import type { IntendedSpec } from '@sangfor/spec';

export const cisco_interface_baseline: IntendedSpec = {
  id: 'spec_cisco_iosxe_17_0_0_interface',
  product: 'CISCO_IOSXE',
  version: '17.0.0',
  items: [
    {
      id: 'interface_count',
      capabilityId: 'wan_connectivity',
      label: '인터페이스 개수',
      observedKey: 'interfaceCount',
      op: 'exists',
      severity: 'must',
      source: {
        manual: 'Cisco IOS XE 17.0 Configuration Guide — Interface Configuration',
      },
    },
    {
      id: 'loopback_interfaces',
      capabilityId: 'wan_connectivity',
      label: 'Loopback 인터페이스 개수',
      observedKey: 'loopbackCount',
      op: 'exists',
      severity: 'must',
      source: {
        manual: 'Cisco IOS XE 17.0 Configuration Guide — Loopback Interfaces',
      },
    },
  ],
};

export const cisco_routing_baseline: IntendedSpec = {
  id: 'spec_cisco_iosxe_17_0_0_routing',
  product: 'CISCO_IOSXE',
  version: '17.0.0',
  items: [
    {
      id: 'static_routes_count',
      capabilityId: 'internet_policy',
      label: '정적 라우트 개수',
      observedKey: 'staticRouteCount',
      op: 'exists',
      severity: 'must',
      source: {
        manual: 'Cisco IOS XE 17.0 Configuration Guide — Static Routing',
      },
    },
    {
      id: 'ospf_enabled',
      capabilityId: 'internet_policy',
      label: 'OSPF 라우팅 활성',
      observedKey: 'ospfEnabled',
      op: 'exists',
      severity: 'must',
      source: {
        manual: 'Cisco IOS XE 17.0 Configuration Guide — OSPF',
      },
    },
  ],
};
