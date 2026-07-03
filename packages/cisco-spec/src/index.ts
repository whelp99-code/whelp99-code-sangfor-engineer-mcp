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

export const cisco_system_health_baseline: IntendedSpec = {
  id: 'spec_cisco_iosxe_17_0_0_system_health',
  product: 'CISCO_IOSXE',
  version: '17.0.0',
  items: [
    {
      id: 'system_cpu_usage_per_core',
      capabilityId: 'system_health',
      label: '코어별 CPU 사용률 (평균)',
      observedKey: 'systemCpuUsageAverage',
      op: 'exists',
      severity: 'must',
    },
    {
      id: 'system_memory_usage',
      capabilityId: 'system_health',
      label: '시스템 메모리 사용률',
      observedKey: 'systemMemoryUsage',
      op: 'exists',
      severity: 'must',
    },
    {
      id: 'interface_down_count',
      capabilityId: 'wan_connectivity',
      label: '다운된 인터페이스 개수',
      observedKey: 'interfaceDownCount',
      op: 'exists',
      severity: 'must',
    },
    {
      id: 'vrf_count',
      capabilityId: 'redundancy',
      label: 'VRF (가상 라우팅) 개수',
      observedKey: 'vrfCount',
      op: 'exists',
      severity: 'must',
    },
  ],
};

export const cisco_policy_audit_baseline: IntendedSpec = {
  id: 'spec_cisco_iosxe_17_0_0_policy_audit',
  product: 'CISCO_IOSXE',
  version: '17.0.0',
  items: [
    {
      id: 'zone_pair_policy_count',
      capabilityId: 'internet_policy',
      label: 'Zone-Pair 정책 개수',
      observedKey: 'zonePairPolicyCount',
      op: 'exists',
      severity: 'must',
    },
    {
      id: 'acl_rule_count',
      capabilityId: 'internet_policy',
      label: 'ACL 규칙 개수',
      observedKey: 'aclRuleCount',
      op: 'exists',
      severity: 'must',
    },
    {
      id: 'snort_signature_version',
      capabilityId: 'threat_prevention',
      label: 'Snort 서명 버전',
      observedKey: 'snortSignatureVersion',
      op: 'exists',
      severity: 'must',
    },
    {
      id: 'snort_inspection_enabled',
      capabilityId: 'threat_prevention',
      label: 'Snort IPS 검사 활성',
      observedKey: 'snortInspectionEnabled',
      op: 'exists',
      severity: 'must',
    },
  ],
};
