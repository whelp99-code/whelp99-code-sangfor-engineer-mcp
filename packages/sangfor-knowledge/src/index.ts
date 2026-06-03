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
