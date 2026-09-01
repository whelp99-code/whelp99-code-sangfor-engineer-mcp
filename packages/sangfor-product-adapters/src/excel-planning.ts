import { nowId } from '@sangfor/shared';
import type { RiskLevel } from '@sangfor/shared';
import { importExcelRequirementList } from './excel-import.js';
import { bestCapability } from './requirement-planning.js';
import { getProductAdapter } from './source-mapping.js';
import type {
  ExcelBasedChangePlan,
  ExcelRequirementRow,
  ExcelWorkPlanItem,
  MappedRequirement,
  RequirementMappingResult,
  RequirementProductCode,
} from './types.js';

export function mapRequirementsToProducts(input: { rows: ExcelRequirementRow[] }): RequirementMappingResult {
  const rows = input.rows.map(row => mapExcelRequirement(row));
  const summary = rows.reduce<Record<RequirementProductCode, number>>((acc, row) => {
    acc[row.mappedProduct] = (acc[row.mappedProduct] ?? 0) + 1;
    return acc;
  }, { HCI_SCP: 0, IAG: 0, ENDPOINT_SECURE: 0, NDR: 0, external_or_manual: 0 });
  return { id: nowId('requirement_map'), rows, summary };
}

export function generateExcelBasedChangePlan(input: { filePath?: string; rows?: ExcelRequirementRow[]; sheetName?: string; prioritizeOnly?: boolean }): ExcelBasedChangePlan {
  const imported = input.rows
    ? { rows: input.rows }
    : importExcelRequirementList({ filePath: requiredFilePath(input.filePath), sheetName: input.sheetName, prioritizeOnly: input.prioritizeOnly ?? true });
  const mapped = mapRequirementsToProducts({ rows: imported.rows });
  const executableRows = mapped.rows.filter(row => row.mappedProduct !== 'external_or_manual');
  return {
    id: nowId('excel_plan'),
    source: 'excel',
    product: 'MULTI_PRODUCT',
    strategy: 'excel-driven-dry-run',
    summary: `Generated Excel-driven dry-run plan for ${mapped.rows.length} checklist row(s); ${executableRows.length} mapped to Sangfor product consoles.`,
    workPlan: mapped.rows.map(toExcelWorkPlanItem),
    tasks: mapped.rows,
    dryRunRequired: true,
    mutationPerformed: false,
    stoppedBefore: ['Save', 'Apply', 'Delete', 'Commit', 'Policy Enable', 'Agent Deployment', 'SOAR Response Action'],
    executionGates: [
      'sessionId is required for Playwright console dry-run.',
      'Local Chrome must expose a CDP endpoint for existing-browser operation.',
      'Dry-run may navigate and collect screenshots, but must not click Save/Apply/Delete or execute response actions.',
      'Rows mapped to external_or_manual are reported for manual/non-Sangfor handling.'
    ],
    manualReviewRows: mapped.rows.filter(row => row.mappedProduct === 'external_or_manual').map(row => row.rowId)
  };
}

function mapExcelRequirement(row: ExcelRequirementRow): MappedRequirement {
  const text = `${row.category ?? ''} ${row.solution ?? ''} ${row.item ?? ''} ${row.specificDetails ?? ''} ${row.reason ?? ''}`.toLowerCase();
  const mappedProduct = classifyRequirementProduct(text);
  if (mappedProduct === 'external_or_manual') {
    return {
      ...row,
      mappedProduct,
      mappingReason: 'No direct Sangfor target product mapping found or the control references a non-Sangfor solution.',
      menuPath: [],
      apiEndpointCandidates: [],
      riskLevel: row.priority === 'high' ? 'medium' : 'low',
      approvalRequired: false,
      actualApplySupported: false
    };
  }
  const adapter = getProductAdapter(mappedProduct);
  const capability = bestCapability(adapter, text);
  const riskLevel = maxRisk(capability.riskLevel, row.priority === 'high' ? 'medium' : 'low');
  return {
    ...row,
    mappedProduct,
    mappingReason: `${mappedProduct} matched from checklist keywords; capability=${capability.id}`,
    capabilityId: capability.id,
    menuPath: capability.menuPath,
    apiEndpointCandidates: capability.apiEndpointCandidates,
    riskLevel,
    approvalRequired: capability.approvalRequired || riskLevel === 'high' || riskLevel === 'critical',
    actualApplySupported: false
  };
}

function toExcelWorkPlanItem(row: MappedRequirement): ExcelWorkPlanItem {
  const manual = row.mappedProduct === 'external_or_manual';
  const menu = manual ? 'Manual / External evidence' : row.menuPath.join(' > ');
  const setting = row.capabilityId
    ? settingLabel(row.capabilityId)
    : row.solution || row.item || row.requirement;
  return {
    requestId: row.no ? `REQ-${row.no}` : row.rowId,
    excelRowId: row.rowId,
    no: row.no,
    product: row.mappedProduct,
    menu,
    setting,
    description: row.requirement,
    currentGap: row.currentGap || 'No explicit gap text; verify checklist result and current console state.',
    target: row.targetControl,
    evidence: row.evidenceNeed,
    dryRunAction: manual
      ? 'Do not access Sangfor console. Collect external/manual evidence and attach to review.'
      : `Open ${row.mappedProduct} console, navigate to ${menu}, capture current configuration evidence, stop before Save/Apply.`,
    status: manual ? 'manual_review_required' : 'dry_run_ready',
    approvalRequired: row.approvalRequired,
    actualApplySupported: false
  };
}

function settingLabel(capabilityId: string): string {
  const labels: Record<string, string> = {
    resource_inventory: 'Resource/alert/license inventory check',
    ha_drs: 'HA/DRS/availability configuration check',
    vm_resource: 'VM resource and power-state check',
    license_alert: 'License/NTP/alert validation',
    auth_source: 'Authentication source and policy check',
    internet_policy: 'Internet/URL/application access policy check',
    log_validation: 'Log retention and audit validation',
    endpoint_inventory: 'Endpoint/agent inventory check',
    protection_policy: 'Anti-malware scan and protection policy check',
    app_control: 'Software/application control policy check',
    device_control: 'USB/device control policy check',
    security_events: 'Security event logs and audit trail',
    syslog_export: 'Syslog/SIEM log forwarding check',
    agent_deployment: 'Agent deployment/self-protection check',
    event_source: 'Event source/sensor integration check',
    incident_alert: 'Incident/alert/dashboard validation',
    soar_response: 'SOAR/playbook response policy check'
  };
  return labels[capabilityId] ?? capabilityId;
}

function classifyRequirementProduct(text: string): RequirementProductCode {
  if (hasAny(text, ['crowdstrike', 'alyac', 'anti-spam', 'spamout', 'webmail', 'data loss prevention', 'dlp'])) return 'external_or_manual';
  if (hasAny(text, ['backup management', 'backup data', 'backup objective', 'backup objectives', 'recovery test', 'disaster recovery', 'firewall config'])) return 'external_or_manual';
  if (hasAny(text, ['hci/scp', 'hci', 'scp', 'vm ', 'virtual machine', 'resource pool', 'ha/drs', 'drs', 'storage network', 'ntp', 'license mismatch', 'node'])) return 'HCI_SCP';
  if (hasAny(text, ['software control', 'device control', 'unauthorized software', 'storage media', 'anti-virus', 'antivirus', 'edr', 'epp', 'malware', 'ransomware', 'agent', 'endpoint', 'engine update', 'virus'])) return 'ENDPOINT_SECURE';
  if (hasAny(text, ['log retention', 'retained at least 1 year', 'retained for less than 1 year', 'network access contro', 'network access control', 'nac', 'internet access', 'vpn', 'f/w', 'firewall', 'dmz', 'auth', 'ldap', 'ad ', 'url', 'application policy', 'access policy'])) return 'IAG';
  if (hasAny(text, ['log management', 'security monitoring', 'siem', 'security system logs', 'event source', 'incident', 'alert', 'soar', 'sensor', 'dashboard', 'response', 'playbook'])) return 'NDR';
  return 'external_or_manual';
}

function requiredFilePath(filePath?: string): string {
  if (!filePath) throw new Error('filePath is required when rows are not provided.');
  return filePath;
}


function hasAny(value: string, terms: string[]): boolean {
  return terms.some(term => value.includes(term));
}

function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  const order: RiskLevel[] = ['low', 'medium', 'high', 'critical'];
  return order[Math.max(order.indexOf(a), order.indexOf(b))];
}
