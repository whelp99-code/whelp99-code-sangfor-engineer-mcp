import { KnowledgeChunk } from '@sangfor/shared';

export const WIKI_CHUNKS: readonly KnowledgeChunk[] = [
  {
    id: 'wiki_hci_mtu_lesson_001',
    sourceType: 'wiki',
    product: 'HCI',
    title: 'HCI 3-Node Deployment Lessons',
    section: 'Storage Network MTU',
    text: 'Internal lesson: HCI 3-node deployment should include MTU consistency check on storage network before cluster initialization. Missing this precheck caused unstable storage heartbeat in previous PoC.',
    trustLevel: 'internal'
  },
  {
    id: 'wiki_iag_policy_order_001',
    sourceType: 'wiki',
    product: 'IAG',
    title: 'IAG Policy Ordering Notes',
    section: 'Policy Priority',
    text: 'Internal lesson: define emergency bypass and admin exception policy before applying restrictive internet access policies. Always capture current policy export before applying changes.',
    trustLevel: 'internal'
  },
  {
    id: 'wiki_es_staged_rollout_001',
    sourceType: 'wiki',
    product: 'ENDPOINT_SECURE',
    title: 'Endpoint Secure Staged Rollout',
    section: 'Pilot Group',
    text: 'Internal lesson: deploy Endpoint Secure agents to a pilot group first, validate performance impact, then expand by department. Keep rollback uninstall package ready.',
    trustLevel: 'internal'
  },
  {
    id: 'wiki_cc_time_sync_001',
    sourceType: 'wiki',
    product: 'CYBER_COMMAND',
    title: 'Cyber Command Event Correlation',
    section: 'NTP and Timezone',
    text: 'Internal lesson: event correlation quality depends on NTP and timezone consistency across all sources. Add NTP validation to Cyber Command onboarding precheck.',
    trustLevel: 'internal'
  },
  {
    id: 'wiki_hci_license_001',
    sourceType: 'wiki',
    product: 'HCI',
    title: 'HCI License Activation Pitfall',
    section: 'Cluster UUID',
    text: 'Internal lesson: activate licenses only after all nodes join cluster; re-activation may be required if a node is replaced with different hardware UUID.',
    trustLevel: 'internal'
  },
  {
    id: 'wiki_hci_vmware_001',
    sourceType: 'wiki',
    product: 'HCI',
    title: 'VMware to HCI Migration',
    section: 'Cutover Window',
    text: 'Internal lesson: keep source VMware powered off validation step in runbook; document LUN mapping and boot order before cutover weekend.',
    trustLevel: 'internal'
  },
  {
    id: 'wiki_iag_ssl_001',
    sourceType: 'wiki',
    product: 'IAG',
    title: 'IAG SSL Inspection Exceptions',
    section: 'Certificate Pinning Apps',
    text: 'Internal lesson: maintain exception list for banking and health apps that break on SSL inspection; review quarterly.',
    trustLevel: 'internal'
  },
  {
    id: 'wiki_es_perf_001',
    sourceType: 'wiki',
    product: 'ENDPOINT_SECURE',
    title: 'Endpoint Secure Performance',
    section: 'Full Scan Schedule',
    text: 'Internal lesson: schedule full scans outside business hours; disable concurrent full scan on VDI gold images.',
    trustLevel: 'internal'
  },
  {
    id: 'wiki_cc_playbook_001',
    sourceType: 'wiki',
    product: 'CYBER_COMMAND',
    title: 'SOC Playbook Links',
    section: 'Runbook Integration',
    text: 'Internal lesson: link each high-severity alert rule to Confluence/Jira runbook URL in rule description for faster L1 response.',
    trustLevel: 'internal'
  }
];

export function listSeedWiki(): KnowledgeChunk[] {
  return [...WIKI_CHUNKS];
}
