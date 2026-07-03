import type { IntendedSpec, SpecItem } from '@sangfor/spec';

export const fortios_policy_baseline: IntendedSpec = {
  id: 'spec_fortios_8_0_0_policy',
  product: 'FORTIOS',
  version: '8.0.0',
  items: [
    {
      id: 'firewall_policy_count',
      capabilityId: 'internet_policy',
      label: '파이어월 정책 개수',
      observedKey: 'policyCount',
      op: 'exists',
      severity: 'must',
      source: {
        manual: 'FortiOS 8.0 Administration Guide — Firewall Policy',
      },
    },
    {
      id: 'ssl_inspection_enabled',
      capabilityId: 'internet_policy',
      label: 'SSL/TLS 검사 활성',
      observedKey: 'sslInspectionEnabled',
      op: 'exists',
      severity: 'must',
      source: {
        manual: 'FortiOS 8.0 Administration Guide — SSL/SSH Inspection',
      },
    },
    {
      id: 'threat_logging_enabled',
      capabilityId: 'internet_policy',
      label: '위협 로깅 활성',
      observedKey: 'threatLoggingEnabled',
      op: 'exists',
      severity: 'must',
      source: {
        manual: 'FortiOS 8.0 Administration Guide — Logging and Reporting',
      },
    },
  ],
};

export const fortios_interface_baseline: IntendedSpec = {
  id: 'spec_fortios_8_0_0_interface',
  product: 'FORTIOS',
  version: '8.0.0',
  items: [
    {
      id: 'wan_interface_count',
      capabilityId: 'wan_connectivity',
      label: 'WAN 인터페이스 개수',
      observedKey: 'wanInterfaceCount',
      op: 'exists',
      severity: 'must',
      source: {
        manual: 'FortiOS 8.0 Administration Guide — Interface Configuration',
      },
    },
  ],
};
