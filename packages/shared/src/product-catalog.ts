export type ProductCode =
  | 'HCI_SCP'
  | 'HCI'
  | 'NGFW'
  | 'SCC'
  | 'IAG'
  | 'ENDPOINT_SECURE'
  | 'NDR'
  | 'CYBER_COMMAND'
  | 'HIWARE'
  | 'OTHER';

export const PRODUCT_PRIORITY: ProductCode[] = [
  'HCI_SCP',
  'IAG',
  'ENDPOINT_SECURE',
  'NDR',
  'HCI',
  'CYBER_COMMAND',
  'NGFW',
  'SCC',
  'HIWARE',
  'OTHER'
];

export interface SangforProduct {
  code: ProductCode;
  name: string;
  priority: number;
  aliases: string[];
  mvpScope: string[];
}

export const PRODUCTS: SangforProduct[] = [
  {
    code: 'HCI_SCP',
    name: 'Sangfor HCI/SCP',
    priority: 1,
    aliases: ['HCI/SCP', 'SCP', 'Sangfor Cloud Platform', 'Sangfor SCP', 'aCloud', 'HCI SCP'],
    mvpScope: ['API-first config collection', 'resource pool and VM planning', 'HA/DRS planning', 'license and alert validation']
  },
  {
    code: 'HCI',
    name: 'Sangfor HCI',
    priority: 5,
    aliases: ['HCI', 'aSV', 'Sangfor HCI', 'Hyper-Converged Infrastructure'],
    mvpScope: ['cluster deployment', 'network precheck', 'storage precheck', 'VM migration planning', 'DR PoC planning']
  },
  {
    code: 'NGFW',
    name: 'Sangfor NGFW',
    priority: 7,
    aliases: ['NGFW', 'NGAF', 'Athena NGFW', 'Next-Generation Firewall'],
    mvpScope: ['firewall policy planning', 'bandwidth management', 'VPN planning', 'security validation']
  },
  {
    code: 'SCC',
    name: 'Sangfor Data Center Cloud',
    priority: 8,
    aliases: ['SCC', 'Sangfor Data Center Cloud', 'Data Center Cloud'],
    mvpScope: ['tenant operations', 'quota planning', 'cloud resource validation']
  },
  {
    code: 'IAG',
    name: 'Sangfor IAG',
    priority: 2,
    aliases: ['IAG', 'Internet Access Gateway', 'IAM', 'access gateway'],
    mvpScope: ['user/group policy planning', 'internet access control', 'authentication integration', 'audit log validation']
  },
  {
    code: 'ENDPOINT_SECURE',
    name: 'Sangfor Endpoint Secure',
    priority: 3,
    aliases: ['Endpoint Secure', 'Endpoint Security', 'EPP', 'EDR', 'aSEC'],
    mvpScope: ['agent deployment plan', 'EPP/EDR policy plan', 'exception policy', 'update and rollout validation']
  },
  {
    code: 'NDR',
    name: 'Sangfor NDR / Cyber Command',
    priority: 4,
    aliases: ['NDR', 'Athena NDR', 'Cyber Command', 'Sangfor Cyber Command', 'security operations', 'SOC'],
    mvpScope: ['event source onboarding', 'incident and alert validation', 'SOAR/playbook planning', 'third-party API integration readiness']
  },
  {
    code: 'CYBER_COMMAND',
    name: 'Sangfor Cyber Command',
    priority: 6,
    aliases: ['Cyber Command legacy', 'Sangfor Cyber Command legacy'],
    mvpScope: ['event collection planning', 'alert policy planning', 'dashboard/report validation', 'integration readiness']
  },
  {
    code: 'HIWARE',
    name: 'HIWARE Privileged Access Management',
    priority: 9,
    aliases: ['HIWARE', 'HIWARE PSM', 'HIWARE 6', 'HIWARE PAM', 'PSM for System'],
    mvpScope: ['privileged access policy review', 'OTP readiness', 'session audit review', 'approval workflow validation']
  },
  {
    code: 'OTHER',
    name: 'Other Sangfor Product',
    priority: 99,
    aliases: ['OTHER'],
    mvpScope: ['source-preserving knowledge retrieval']
  }
];

export function normalizeProduct(input?: string): ProductCode {
  const raw = (input ?? '').trim();
  const value = raw.toLowerCase().replace(/[\s-]+/g, '_');
  const exact = PRODUCTS.find(p => p.code.toLowerCase() === value || p.code === raw);
  if (exact) return exact.code;
  for (const product of PRODUCTS) {
    if (product.aliases.some(alias => {
      const a = alias.toLowerCase();
      return value === a.replace(/[\s-]+/g, '_') || new RegExp(`\\b${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(raw);
    })) return product.code;
  }
  return 'HCI';
}
