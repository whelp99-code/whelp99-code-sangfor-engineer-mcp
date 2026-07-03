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

export const fortios_system_health_baseline: IntendedSpec = {
  id: 'spec_fortios_8_0_0_system_health',
  product: 'FORTIOS',
  version: '8.0.0',
  items: [
    {
      id: 'system_cpu_usage',
      capabilityId: 'system_health',
      label: '시스템 CPU 사용률',
      observedKey: 'systemCpuUsage',
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
      id: 'system_disk_usage',
      capabilityId: 'system_health',
      label: '시스템 디스크 사용률',
      observedKey: 'systemDiskUsage',
      op: 'exists',
      severity: 'must',
    },
    {
      id: 'npu_cpu_usage',
      capabilityId: 'system_health',
      label: 'NPU (ASIC) CPU 사용률',
      observedKey: 'npuCpuUsage',
      op: 'exists',
      severity: 'must',
    },
    {
      id: 'ha_mode',
      capabilityId: 'redundancy',
      label: 'HA 모드 (Active-Passive/Active-Active)',
      observedKey: 'haMode',
      op: 'exists',
      severity: 'must',
    },
    {
      id: 'ha_primary_unit',
      capabilityId: 'redundancy',
      label: 'HA 주 장치 여부',
      observedKey: 'haPrimaryUnit',
      op: 'exists',
      severity: 'must',
    },
  ],
};

export const fortios_policy_audit_baseline: IntendedSpec = {
  id: 'spec_fortios_8_0_0_policy_audit',
  product: 'FORTIOS',
  version: '8.0.0',
  items: [
    {
      id: 'policy_syntax_valid',
      capabilityId: 'internet_policy',
      label: '정책 구문 유효성',
      observedKey: 'policySyntaxValid',
      op: 'exists',
      severity: 'must',
    },
    {
      id: 'policy_duplicate_count',
      capabilityId: 'internet_policy',
      label: '중복 정책 개수',
      observedKey: 'policyDuplicateCount',
      op: 'exists',
      severity: 'must',
    },
    {
      id: 'ips_signature_version',
      capabilityId: 'threat_prevention',
      label: 'IPS 서명 버전',
      observedKey: 'ipsSignatureVersion',
      op: 'exists',
      severity: 'must',
    },
  ],
};
