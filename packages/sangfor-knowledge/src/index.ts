import { KnowledgeChunk, ProductCode, normalizeProduct } from '@sangfor/shared';

const MANUAL_CHUNKS: KnowledgeChunk[] = [
  {
    id: 'manual_hci_precheck_001',
    sourceType: 'manual',
    product: 'HCI',
    title: 'HCI Deployment Precheck',
    section: 'Network and Storage Readiness',
    text: 'Before HCI cluster initialization, verify management network reachability, storage network isolation, interface mapping, MTU consistency, DNS/NTP, license status, and node hardware health.',
    trustLevel: 'official'
  },
  {
    id: 'manual_hci_migration_001',
    sourceType: 'manual',
    product: 'HCI',
    title: 'HCI VM Migration Planning',
    section: 'Source Platform and Rollback',
    text: 'For VM migration or DR PoC, confirm source hypervisor, VM count, storage size, RPO/RTO expectation, backup state, network mapping, and rollback window before production cutover.',
    trustLevel: 'official'
  },
  {
    id: 'manual_iag_policy_001',
    sourceType: 'manual',
    product: 'IAG',
    title: 'IAG Policy Design',
    section: 'Users, Groups and Internet Access Control',
    text: 'For IAG access policy design, collect user group source, authentication integration, URL category policy, application control policy, logging requirement, bypass exception, and rollback policy.',
    trustLevel: 'official'
  },
  {
    id: 'manual_endpoint_secure_001',
    sourceType: 'manual',
    product: 'ENDPOINT_SECURE',
    title: 'Endpoint Secure Deployment',
    section: 'Agent Rollout and Policy Validation',
    text: 'For Endpoint Secure rollout, verify endpoint OS support, agent installation method, network reachability to management server, AV/EDR policy baseline, exception list, and staged deployment group.',
    trustLevel: 'official'
  },
  {
    id: 'manual_cyber_command_001',
    sourceType: 'manual',
    product: 'CYBER_COMMAND',
    title: 'Cyber Command Integration',
    section: 'Event Collection and Dashboard Verification',
    text: 'For Cyber Command, verify event source list, collector reachability, time synchronization, alert rule mapping, dashboard scope, report recipients, and incident response workflow.',
    trustLevel: 'official'
  },
  {
    id: 'manual_hci_storage_001',
    sourceType: 'manual',
    product: 'HCI',
    version: '6.11',
    title: 'HCI Storage Network Design',
    section: 'MTU and Bonding',
    text: 'Storage network should use dedicated VLAN, LACP bonding where supported, jumbo frame MTU 9000 only when end-to-end path supports it. Validate switch port MTU before cluster init.',
    trustLevel: 'official'
  },
  {
    id: 'manual_hci_dr_001',
    sourceType: 'manual',
    product: 'HCI',
    title: 'HCI DR PoC Checklist',
    section: 'Replication and Failover',
    text: 'DR PoC requires defined RPO/RTO, replication bandwidth test, failover rehearsal window, DNS/VIP plan, and documented rollback to primary site.',
    trustLevel: 'official'
  },
  {
    id: 'manual_iag_auth_001',
    sourceType: 'manual',
    product: 'IAG',
    title: 'IAG Authentication Integration',
    section: 'LDAP/AD and MFA',
    text: 'Collect identity source type, bind account permissions, MFA method, session timeout, and break-glass admin account policy before enabling production policies.',
    trustLevel: 'official'
  },
  {
    id: 'manual_iag_audit_001',
    sourceType: 'manual',
    product: 'IAG',
    title: 'IAG Audit and Compliance',
    section: 'Logging Retention',
    text: 'Enable URL access logs, policy hit logs, and export to SIEM. Define retention period and PII redaction rules per customer compliance requirement.',
    trustLevel: 'official'
  },
  {
    id: 'manual_endpoint_secure_edr_001',
    sourceType: 'manual',
    product: 'ENDPOINT_SECURE',
    title: 'Endpoint Secure EDR Tuning',
    section: 'Detection and Exceptions',
    text: 'Baseline EDR detections in monitor mode for two weeks before enforcement. Document application allow-list exceptions with owner approval and expiry date.',
    trustLevel: 'official'
  },
  {
    id: 'manual_endpoint_secure_update_001',
    sourceType: 'manual',
    product: 'ENDPOINT_SECURE',
    title: 'Endpoint Secure Update Policy',
    section: 'Staged Signature Rollout',
    text: 'Stage AV/EDR signature updates by pilot group. Verify offline update repository for air-gapped segments before wide rollout.',
    trustLevel: 'official'
  },
  {
    id: 'manual_cyber_command_alert_001',
    sourceType: 'manual',
    product: 'CYBER_COMMAND',
    title: 'Cyber Command Alert Tuning',
    section: 'Noise Reduction',
    text: 'Start with default use-case packs, tune false positives per asset criticality, map alerts to severity matrix and on-call escalation path.',
    trustLevel: 'official'
  },
  {
    id: 'manual_cyber_command_siem_001',
    sourceType: 'manual',
    product: 'CYBER_COMMAND',
    title: 'Cyber Command SIEM Export',
    section: 'Syslog and API',
    text: 'Validate syslog format (CEF/JSON), throughput capacity, and API rate limits for bidirectional ticket integration with ITSM.',
    trustLevel: 'official'
  }
];

export function searchManuals(input: { product?: string; version?: string; query?: string; limit?: number }): KnowledgeChunk[] {
  const product = normalizeProduct(input.product);
  const query = (input.query ?? '').toLowerCase();
  const scored = MANUAL_CHUNKS
    .filter(chunk => chunk.product === product)
    .map(chunk => {
      const text = `${chunk.title} ${chunk.section ?? ''} ${chunk.text}`.toLowerCase();
      const score = query.split(/\s+/).filter(Boolean).reduce((sum, term) => sum + (text.includes(term) ? 1 : 0), 0);
      return { chunk, score };
    })
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, input.limit ?? 5).map(item => item.chunk);
}

export function getManualSection(id: string): KnowledgeChunk | undefined {
  return MANUAL_CHUNKS.find(chunk => chunk.id === id);
}

export function listSeedManuals(): KnowledgeChunk[] {
  return [...MANUAL_CHUNKS];
}
