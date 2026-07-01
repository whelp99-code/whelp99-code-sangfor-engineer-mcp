import { execFileSync } from 'node:child_process';
import { requiresApprovalForText } from '@sangfor/approval';
import { executeLiveConsoleAction, readLiveConsoleState } from '@sangfor/operator';
import { ProductCode, RiskLevel, normalizeProduct, nowId } from '@sangfor/shared';

export { buildSettingGuideDocx, buildOperationsGuideDocx, buildComprehensiveSettingGuideDocx, buildComprehensiveOperationsGuideDocx, type DocxBuilderInput, type DocxBuilderResult } from './docx-builder.js';

export type AutomationProductCode = 'HCI_SCP' | 'IAG' | 'ENDPOINT_SECURE' | 'NDR';
export type RequirementProductCode = AutomationProductCode | 'external_or_manual';
export type AdapterStrategy = 'api-first' | 'webui-first' | 'hybrid';
export type ConfigSource = 'api' | 'webui' | 'api-discovery' | 'hybrid';

export interface ProductCapability {
  id: string;
  title: string;
  collectSections: string[];
  planKeywords: string[];
  riskLevel: RiskLevel;
  approvalRequired: boolean;
  menuPath: string[];
  apiEndpointCandidates: string[];
}

export interface ProductAdapter {
  product: AutomationProductCode;
  aliases: string[];
  strategy: AdapterStrategy;
  authMethods: string[];
  apiLikely: boolean;
  apiCatalogStatus: 'ready' | 'discovery_required' | 'document_required';
  menuRoutes: string[];
  capabilities: ProductCapability[];
}

export interface ProductAutomationInput {
  product?: string;
  targetUrl?: string;
  version?: string;
  environment?: 'lab' | 'poc' | 'customer' | 'production';
  preferApi?: boolean;
}

export interface ProductConfigSnapshot {
  id: string;
  product: AutomationProductCode;
  strategy: AdapterStrategy;
  source: ConfigSource;
  targetUrl?: string;
  version?: string;
  collectedAt: string;
  sections: Array<{
    id: string;
    source: ConfigSource;
    status: 'planned' | 'collectable' | 'needs_discovery';
    evidence: string[];
  }>;
  safety: {
    readOnly: true;
    mutationBlocked: true;
  };
}

export interface RequirementAnalysisInput extends ProductAutomationInput {
  requirements: string[];
  currentConfig?: ProductConfigSnapshot | Record<string, unknown>;
}

export interface RequirementTask {
  id: string;
  product: AutomationProductCode;
  excelRowId?: string;
  objective?: string;
  currentGap?: string;
  evidenceNeed?: string[];
  dryRunActions?: string[];
  actualApplySupported?: boolean;
  requirement: string;
  capabilityId: string;
  menuPath: string[];
  apiEndpointCandidates: string[];
  riskLevel: RiskLevel;
  approvalRequired: boolean;
  rationale: string;
}

export interface ProductChangePlan {
  id: string;
  product: AutomationProductCode;
  strategy: AdapterStrategy;
  summary: string;
  tasks: RequirementTask[];
  rollbackPlan: string[];
  validationPlan: string[];
  executionGates: string[];
}

export interface ApprovalPayload {
  approvedBy?: string;
  approvalToken?: string;
  changeTicketId?: string;
  rollbackPlanId?: string;
}

export interface ExcelRequirementRow {
  rowNumber: number;
  rowId: string;
  no?: string;
  category?: string;
  solution?: string;
  item?: string;
  specificDetails?: string;
  inspectionResult: Record<string, string>;
  resultScore?: number;
  resultRaw?: string;
  reason?: string;
  assessmentCriteria?: string;
  remark?: string;
  requirement: string;
  evidenceNeed: string[];
  targetControl: string;
  currentGap: string;
  priority: 'high' | 'medium' | 'low';
}

export interface ExcelImportResult {
  id: string;
  filePath: string;
  sheetName: string;
  headerRow: number;
  rows: ExcelRequirementRow[];
  summary: {
    totalRows: number;
    prioritizedRows: number;
    highPriorityRows: number;
  };
}

export interface MappedRequirement extends ExcelRequirementRow {
  mappedProduct: RequirementProductCode;
  mappingReason: string;
  capabilityId?: string;
  menuPath: string[];
  apiEndpointCandidates: string[];
  riskLevel: RiskLevel;
  approvalRequired: boolean;
  actualApplySupported: boolean;
}

export interface RequirementMappingResult {
  id: string;
  rows: MappedRequirement[];
  summary: Record<RequirementProductCode, number>;
}

export interface ExcelBasedChangePlan {
  id: string;
  source: 'excel';
  product: 'MULTI_PRODUCT';
  strategy: 'excel-driven-dry-run';
  summary: string;
  workPlan: ExcelWorkPlanItem[];
  tasks: MappedRequirement[];
  dryRunRequired: true;
  mutationPerformed: false;
  stoppedBefore: string[];
  executionGates: string[];
  manualReviewRows: string[];
}

export interface ExcelWorkPlanItem {
  requestId: string;
  excelRowId: string;
  no?: string;
  product: RequirementProductCode;
  menu: string;
  setting: string;
  description: string;
  currentGap: string;
  target: string;
  evidence: string[];
  dryRunAction: string;
  status: 'dry_run_ready' | 'manual_review_required';
  approvalRequired: boolean;
  actualApplySupported: boolean;
}

const HCI_SCP_ENDPOINTS = [
  'POST /janus/v2/public-key',
  'POST /janus/v2/login',
  'GET /janus/20180725/tasks/{task_id}',
  'GET /openstack/compute/v2/servers',
  'GET /openstack/image/v2/images',
  'GET /openstack/volume/v2/volumes',
  'GET /openstack/network/v2.0/networks'
];

const IAG_WEBUI_ROUTES = [
  'WEBUI GET System > Interfaces',
  'WEBUI GET System > Routing',
  'WEBUI GET User Management > Authentication Source',
  'WEBUI GET Policy > Access Control',
  'WEBUI GET Policy > URL/Application Control',
  'WEBUI GET Logs > Internet Access Logs'
];

const ENDPOINT_SECURE_WEBUI_ROUTES = [
  'WEBUI GET Dashboard (Home) > Agent Status',
  'WEBUI GET Defense > Malware Scan',
  'WEBUI GET Policies > App Control',
  'WEBUI GET Policies > General Policies > Endpoint Control > USB Device Control',
  'WEBUI GET Detection and Response > Security Events',
  'WEBUI GET Endpoints > Endpoint Inventory',
  'WEBUI GET System > Agent Deployment',
  'WEBUI GET System > Data Sync > Syslog Reporting'
];

const NDR_API_ENDPOINTS = [
  'GET /api/v1/event_sources',
  'GET /api/v1/sensors',
  'GET /api/v1/incidents',
  'GET /api/v1/alerts/rules',
  'GET /api/v1/dashboards',
  'GET /api/v1/soar/playbooks',
  'POST /api/v1/soar/playbooks/{id}/execute'
];

const DEFAULT_EVIDENCE_NEEDS = ['current setting screenshot', 'audit/checklist row reference', 'before/after comparison candidate'];

const ADAPTERS: Record<AutomationProductCode, ProductAdapter> = {
  HCI_SCP: {
    product: 'HCI_SCP',
    aliases: ['hci_scp', 'hci/scp', 'scp', 'hci', 'acloud', 'sangfor cloud platform'],
    strategy: 'api-first',
    authMethods: ['SCP OpenAPI token/signature flow', 'WebUI session fallback'],
    apiLikely: true,
    apiCatalogStatus: 'ready',
    menuRoutes: [
      'Home > Overview',
      'Resource Center > Resource Pools',
      'Resource Center > Virtual Machines',
      'Resource Center > Network > Topology',
      'Reliability > HA',
      'Reliability > DRS',
      'System > Licensing',
      'Operations > Alerts',
      'Operations > Tasks'
    ],
    capabilities: [
      capability('resource_inventory', 'Resource pool, node, VM, storage, network collection', ['version', 'license', 'resource_pool', 'node', 'vm', 'storage', 'network', 'alert', 'task'], ['resource', 'node', 'vm', 'storage', 'network', 'inventory', 'alert', 'license'], 'low', false, ['Resource Center', 'Resource Pools'], HCI_SCP_ENDPOINTS),
      capability('ha_drs', 'HA/DRS planning', ['ha', 'drs', 'resource_pool', 'task'], ['ha', 'drs', 'availability', 'cluster balance'], 'high', true, ['Reliability', 'HA/DRS'], ['GET /janus/20180725/tasks/{task_id}', 'PUT /openstack/compute/v2/servers/{id}/metadata']),
      capability('vm_resource', 'VM resource and power operation planning', ['vm', 'task'], ['vm', 'cpu', 'memory', 'migrate', 'power', 'delete'], 'critical', true, ['Resource Center', 'Virtual Machines'], ['GET /openstack/compute/v2/servers', 'POST /openstack/compute/v2/servers/{id}/action']),
      capability('license_alert', 'License and alert mismatch validation', ['version', 'license', 'alert'], ['license', 'mismatch', 'alert', 'ntp'], 'medium', false, ['System', 'Licensing'], ['GET /janus/20180725/tasks/{task_id}'])
    ]
  },
  IAG: {
    product: 'IAG',
    aliases: ['iag', 'internet access gateway', 'iam', 'access gateway'],
    strategy: 'webui-first',
    authMethods: ['WebUI session', 'Network/API discovery when enabled'],
    apiLikely: false,
    apiCatalogStatus: 'ready',
    menuRoutes: [
      'System > Interfaces',
      'System > Routing',
      'User Management > Authentication Source',
      'Policy > Access Control',
      'Policy > URL/Application Control',
      'Logs > Internet Access Logs'
    ],
    capabilities: [
      capability('auth_source', 'AD/LDAP and authentication policy planning', ['version', 'license', 'interface', 'route', 'user_auth'], ['ad', 'ldap', 'authentication', 'user', 'group', 'sso'], 'high', true, ['User Management', 'Authentication Source'], IAG_WEBUI_ROUTES),
      capability('internet_policy', 'Internet access, URL and application policy planning', ['access_policy', 'url_application_policy', 'logs'], ['internet', 'url', 'application', 'policy', 'exception', 'allow', 'block'], 'high', true, ['Policy', 'Access Control'], IAG_WEBUI_ROUTES),
      capability('log_validation', 'Log and audit validation', ['logs'], ['log', 'audit', 'report', 'verify'], 'low', false, ['Logs', 'Internet Access Logs'], IAG_WEBUI_ROUTES)
    ]
  },
  ENDPOINT_SECURE: {
    product: 'ENDPOINT_SECURE',
    aliases: ['endpoint secure', 'endpoint security', 'edr', 'epp', 'asec'],
    strategy: 'webui-first',
    authMethods: ['WebUI session', 'Operator dry-run route catalog'],
    apiLikely: false,
    apiCatalogStatus: 'ready',
    menuRoutes: [
      'Dashboard (Home)',
      'Detection and Response > Security Events',
      'Defense > Malware Scan',
      'Endpoints > Endpoint Inventory',
      'Policies > App Control',
      'Policies > General Policies > Endpoint Control > USB Device Control',
      'System > Agent Deployment',
      'System > Data Sync > Syslog Reporting'
    ],
    capabilities: [
      capability('endpoint_inventory', 'Endpoint, agent and update status collection', ['license', 'endpoint_agent', 'update_status'], ['endpoint', 'agent', 'online', 'offline', 'update', '에이전트', '설치'], 'low', false, ['Dashboard (Home)'], ENDPOINT_SECURE_WEBUI_ROUTES),
      capability('protection_policy', 'Anti-malware scan and protection policy', ['policy', 'malware_ransomware', 'exception_list'], ['policy', 'malware', 'ransomware', 'scan', 'anti-virus', 'antivirus', 'engine update', '검사', '엔진'], 'high', true, ['Defense', 'Malware Scan'], ENDPOINT_SECURE_WEBUI_ROUTES),
      capability('app_control', 'Software/application control policy', ['policy', 'software_control'], ['software control', 'unauthorized software', 'application', 'app control', '소프트웨어', '통제'], 'high', true, ['Policies', 'App Control'], ENDPOINT_SECURE_WEBUI_ROUTES),
      capability('device_control', 'USB and device control policy', ['policy', 'device_control'], ['device control', 'usb', 'storage media', '저장매체', 'usb device'], 'high', true, ['Policies', 'General Policies', 'Endpoint Control', 'USB Device Control'], ENDPOINT_SECURE_WEBUI_ROUTES),
      capability('security_events', 'Security event logs and audit trail', ['logs', 'security_events', 'audit'], ['log', 'event', 'audit', 'detection', '보안 이벤트', '로그', '감사'], 'low', false, ['Detection and Response', 'Security Events'], ENDPOINT_SECURE_WEBUI_ROUTES),
      capability('agent_deployment', 'Agent deployment planning', ['endpoint_agent', 'policy'], ['deploy', 'deployment', 'install', 'agent', 'agent rollout', '배포'], 'high', true, ['System', 'Agent Deployment'], ENDPOINT_SECURE_WEBUI_ROUTES),
      capability('syslog_export', 'Syslog/SIEM log forwarding', ['logs', 'syslog', 'siem'], ['syslog', 'siem', 'log export', 'data sync', '로그 전송'], 'medium', false, ['System', 'Data Sync', 'Syslog Reporting'], ENDPOINT_SECURE_WEBUI_ROUTES)
    ]
  },
  NDR: {
    product: 'NDR',
    aliases: ['ndr', 'cyber command', 'athena ndr', 'soc'],
    strategy: 'hybrid',
    authMethods: ['WebUI session', 'NDR REST API catalog (third-party integration doc)'],
    apiLikely: true,
    apiCatalogStatus: 'ready',
    menuRoutes: [
      'Dashboard > Security Operations',
      'Assets > Sensors/Connectors',
      'Events > Event Sources',
      'Incidents > Incident List',
      'Alerts > Alert Rules',
      'SOAR > Playbooks',
      'System > Integrations'
    ],
    capabilities: [
      capability('event_source', 'Event source and sensor integration planning', ['version', 'license', 'event_sources', 'sensors_connectors', 'integration_status'], ['event source', 'sensor', 'connector', 'syslog', 'api source', 'ngaf', 'iag', 'endpoint'], 'medium', false, ['Events', 'Event Sources'], NDR_API_ENDPOINTS),
      capability('incident_alert', 'Incident, alert and dashboard validation', ['incidents', 'alerts'], ['incident', 'alert', 'dashboard', 'report'], 'low', false, ['Incidents', 'Incident List'], NDR_API_ENDPOINTS),
      capability('soar_response', 'SOAR/playbook response action planning', ['soar_playbooks'], ['soar', 'playbook', 'response', 'isolate', 'block', 'quarantine'], 'critical', true, ['SOAR', 'Playbooks'], NDR_API_ENDPOINTS)
    ]
  }
};

function capability(
  id: string,
  title: string,
  collectSections: string[],
  planKeywords: string[],
  riskLevel: RiskLevel,
  approvalRequired: boolean,
  menuPath: string[],
  apiEndpointCandidates: string[]
): ProductCapability {
  return { id, title, collectSections, planKeywords, riskLevel, approvalRequired, menuPath, apiEndpointCandidates };
}

export function normalizeAutomationProduct(input?: string): AutomationProductCode {
  const raw = (input ?? '').trim();
  const normalized = raw.toLowerCase().replace(/[\s-]+/g, '_');
  if (!raw) return 'HCI_SCP';
  for (const adapter of Object.values(ADAPTERS)) {
    if (adapter.product.toLowerCase() === normalized) return adapter.product;
    if (adapter.aliases.some(alias => normalized === alias.toLowerCase().replace(/[\s-]+/g, '_'))) return adapter.product;
  }
  const sharedProduct: ProductCode = normalizeProduct(input);
  if (sharedProduct === 'HCI' || sharedProduct === 'HCI_SCP') return 'HCI_SCP';
  if (sharedProduct === 'CYBER_COMMAND' || sharedProduct === 'NDR') return 'NDR';
  if (sharedProduct === 'IAG' || sharedProduct === 'ENDPOINT_SECURE') return sharedProduct;
  return 'HCI_SCP';
}

export function getProductAdapter(product?: string): ProductAdapter {
  return ADAPTERS[normalizeAutomationProduct(product)];
}

export function listProductAdapters(): ProductAdapter[] {
  return Object.values(ADAPTERS);
}

export function discoverProductConsole(input: ProductAutomationInput) {
  const adapter = getProductAdapter(input.product);
  return {
    id: nowId('discover'),
    product: adapter.product,
    targetUrl: input.targetUrl,
    version: input.version,
    strategy: adapter.strategy,
    apiLikely: adapter.apiLikely,
    apiCatalogStatus: adapter.apiCatalogStatus,
    authMethods: adapter.authMethods,
    menuRoutes: adapter.menuRoutes,
    capabilities: adapter.capabilities,
    nextStep: adapter.apiCatalogStatus === 'ready'
      ? 'Use API catalog first, then verify with WebUI evidence.'
      : 'Run read-only WebUI traversal and capture network/API discovery evidence.'
  };
}

export function collectProductConfig(input: ProductAutomationInput): ProductConfigSnapshot {
  const adapter = getProductAdapter(input.product);
  const source = chooseSource(adapter, input.preferApi);
  const sectionIds = unique(adapter.capabilities.flatMap(c => c.collectSections));
  return {
    id: nowId('snapshot'),
    product: adapter.product,
    strategy: adapter.strategy,
    source,
    targetUrl: input.targetUrl,
    version: input.version,
    collectedAt: new Date().toISOString(),
    sections: sectionIds.map(id => ({
      id,
      source,
      status: adapter.apiCatalogStatus === 'document_required' && source !== 'webui' ? 'needs_discovery' : 'collectable',
      evidence: buildEvidenceHints(adapter, id, source)
    })),
    safety: {
      readOnly: true,
      mutationBlocked: true
    }
  };
}

export function analyzeCustomerRequirements(input: RequirementAnalysisInput) {
  const adapter = getProductAdapter(input.product);
  const tasks = input.requirements.map((requirement, index) => taskFromRequirement(adapter, requirement, index));
  return {
    id: nowId('analysis'),
    product: adapter.product,
    strategy: adapter.strategy,
    requirements: input.requirements,
    tasks,
    notes: [
      'Read-only collection can run without approval.',
      'Save/Apply/Delete and security or service-impacting changes remain approval-gated.',
      adapter.apiCatalogStatus === 'ready'
        ? `${adapter.product} route catalog is ready for dry-run previews (API and/or WEBUI).`
        : 'API discovery evidence is needed before API execution is promoted.'
    ]
  };
}

export function generateProductChangePlan(input: RequirementAnalysisInput): ProductChangePlan {
  const adapter = getProductAdapter(input.product);
  const analysis = analyzeCustomerRequirements(input);
  return {
    id: nowId('product_plan'),
    product: adapter.product,
    strategy: adapter.strategy,
    summary: `${adapter.product} ${adapter.strategy} plan for ${analysis.tasks.length} customer requirement(s).`,
    tasks: analysis.tasks,
    rollbackPlan: [
      'Export or capture current configuration before any mutation.',
      'Keep original policy/routing/resource settings available for restore.',
      'Use product-native task history, audit log, and screenshots as rollback evidence.'
    ],
    validationPlan: [
      'Re-collect the same sections after change.',
      'Compare current value, target value, alarms, task status, and logs.',
      'Generate evidence with menu path/API preview, before/after values, and operator approval metadata.'
    ],
    executionGates: [
      'Default mode is read-only/dry-run.',
      'Real execution requires SANGFOR_ALLOW_REAL_EXECUTION=true.',
      'Production execution also requires SANGFOR_ALLOW_PRODUCTION_EXECUTION=true.',
      'Approval payload must include approvedBy, approvalToken, changeTicketId, and rollbackPlanId.'
    ]
  };
}

export function importExcelRequirementList(input: { filePath: string; sheetName?: string; prioritizeOnly?: boolean }): ExcelImportResult {
  const workbook = readXlsxWorkbook(input.filePath);
  const sheet = input.sheetName
    ? workbook.sheets.find(candidate => candidate.name === input.sheetName)
    : workbook.sheets[0];
  if (!sheet) throw new Error(`Excel sheet not found: ${input.sheetName ?? '<first sheet>'}`);

  const headerRow = findChecklistHeaderRow(sheet.rows);
  if (!headerRow) throw new Error('Checklist header row not found. Expected columns such as No, Category, Soultion/Solution, Item, Specific details.');
  const header = mergeHeaderRows(sheet.rows.get(headerRow - 1) ?? {}, sheet.rows.get(headerRow) ?? {});
  const rows: ExcelRequirementRow[] = [];
  for (const [rowNumber, cells] of [...sheet.rows.entries()].sort(([a], [b]) => a - b)) {
    if (rowNumber <= headerRow) continue;
    const no = cellByHeader(cells, header, ['No']);
    const category = cellByHeader(cells, header, ['Category']);
    const solution = cellByHeader(cells, header, ['Soultion', 'Solution']);
    const item = cellByHeader(cells, header, ['Item']);
    const specificDetails = cellByHeader(cells, header, ['Specific details', 'Specific detail']);
    const reason = cellByHeader(cells, header, ['Reason for Inspection Results', 'Reason']);
    const assessmentCriteria = cellByHeader(cells, header, ['Assessment Criteria']) ?? cells.N;
    const remark = cellByHeader(cells, header, ['Remark']) ?? cells.O;
    const resultRaw = cellByHeader(cells, header, ['Results']);
    if (![no, category, solution, item, specificDetails, reason, assessmentCriteria, remark].some(Boolean)) continue;
    const inspectionResult = inspectionResultsFromRow(cells, header);
    const resultScore = parseOptionalNumber(resultRaw);
    const row = normalizeExcelRow({
      rowNumber,
      no,
      category,
      solution,
      item,
      specificDetails,
      inspectionResult,
      resultScore,
      resultRaw,
      reason,
      assessmentCriteria,
      remark
    });
    if (!input.prioritizeOnly || row.priority !== 'low') rows.push(row);
  }
  return {
    id: nowId('excel_import'),
    filePath: input.filePath,
    sheetName: sheet.name,
    headerRow,
    rows,
    summary: {
      totalRows: rows.length,
      prioritizedRows: rows.filter(row => row.priority !== 'low').length,
      highPriorityRows: rows.filter(row => row.priority === 'high').length
    }
  };
}

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

export async function dryRunProductChange(input: { plan: ProductChangePlan | ExcelBasedChangePlan; targetUrl?: string; sessionId?: string }) {
  const excelPlan = isExcelBasedChangePlan(input.plan) ? input.plan : undefined;
  const operatorState = input.sessionId ? await readLiveConsoleState({ sessionId: input.sessionId }) : undefined;
  return {
    id: nowId('dryrun'),
    product: input.plan.product,
    ok: true,
    mutationPerformed: false,
    stoppedBefore: excelPlan ? excelPlan.stoppedBefore : ['Save', 'Apply', 'Delete', 'Commit', 'Response Action'],
    webuiRoutePreview: input.plan.tasks
      .filter(task => !('mappedProduct' in task) || task.mappedProduct !== 'external_or_manual')
      .map(task => ({
      taskId: 'id' in task ? task.id : task.rowId,
      excelRowId: 'rowId' in task ? task.rowId : task.excelRowId,
      menuPath: task.menuPath,
      checks: excelPlan
        ? ['Navigate to mapped product menu', 'Confirm current configuration or evidence gap', 'Capture screenshot evidence', 'Stop before mutation button']
        : ['Navigate to menu', 'Confirm current values', 'Populate draft values if safe', 'Stop before mutation button']
    })),
    apiRequestPreview: input.plan.tasks.flatMap(task => task.apiEndpointCandidates.map(endpoint => ({
      taskId: 'id' in task ? task.id : task.rowId,
      endpoint,
      method: endpoint.split(' ')[0] ?? 'UNKNOWN',
      execute: false
    }))),
    approvalRequiredTasks: input.plan.tasks.filter(task => task.approvalRequired).map(taskIdentifier),
    manualReviewRows: excelPlan ? excelPlan.manualReviewRows : [],
    sessionRequired: Boolean(excelPlan),
    sessionAttached: Boolean(input.sessionId),
    dryRunFailures: excelPlan && !input.sessionId
      ? ['sessionId is required to execute Excel-based Playwright dry-run.']
      : [],
    operatorState
  };
}

export async function applyApprovedProductChange(input: { plan: ProductChangePlan; approval?: ApprovalPayload; environment?: 'lab' | 'poc' | 'customer' | 'production'; sessionId?: string }) {
  const missingApproval = missingApprovalFields(input.approval);
  const highRiskTasks = input.plan.tasks.filter(task => task.approvalRequired || requiresApprovalForText(`${task.requirement} ${task.capabilityId}`).required);
  if (highRiskTasks.length > 0 && missingApproval.length > 0) {
    return {
      id: nowId('apply'),
      ok: false,
      approvalRequired: true,
      mutationPerformed: false,
      reason: `Missing approval payload fields: ${missingApproval.join(', ')}`
    };
  }
  if (process.env.SANGFOR_ALLOW_REAL_EXECUTION !== 'true') {
    return {
      id: nowId('apply'),
      ok: false,
      approvalRequired: highRiskTasks.length > 0,
      mutationPerformed: false,
      reason: 'SANGFOR_ALLOW_REAL_EXECUTION=true is required for real changes.'
    };
  }
  if (input.environment === 'production' && process.env.SANGFOR_ALLOW_PRODUCTION_EXECUTION !== 'true') {
    return {
      id: nowId('apply'),
      ok: false,
      approvalRequired: true,
      mutationPerformed: false,
      reason: 'SANGFOR_ALLOW_PRODUCTION_EXECUTION=true is required for production changes.'
    };
  }
  const operatorEvidence = input.sessionId
    ? await executeLiveConsoleAction({
      sessionId: input.sessionId,
      // Dry-run screenshot for evidence only — the execution gate short-circuits
      // on dryRun before any approval is verified, so no signed approval is passed.
      action: { type: 'screenshot', target: 'product-change-plan', dryRun: true }
    })
    : undefined;
  return {
    id: nowId('apply'),
    ok: true,
    approvalRequired: highRiskTasks.length > 0,
    mutationPerformed: false,
    reason: 'Execution gate passed. Real executor is not attached in this package yet; no mutation was performed.',
    approvedBy: input.approval?.approvedBy,
    changeTicketId: input.approval?.changeTicketId,
    operatorEvidence
  };
}

export function verifyProductChange(input: { plan: ProductChangePlan; observed?: Record<string, unknown> }) {
  return {
    id: nowId('verify'),
    product: input.plan.product,
    ok: true,
    readOnly: true,
    checks: input.plan.tasks.map(task => ({
      taskId: task.id,
      requirement: task.requirement,
      menuPath: task.menuPath,
      expectedEvidence: ['post-change config snapshot', 'task/audit log', 'alert/log verification', 'before-after comparison'],
      observed: input.observed?.[task.id] ?? null
    })),
    evidenceStatus: input.observed ? 'observed_values_attached' : 'pending_observed_values'
  };
}

function chooseSource(adapter: ProductAdapter, preferApi?: boolean): ConfigSource {
  if (adapter.strategy === 'api-first' && preferApi !== false) return 'api';
  if (adapter.strategy === 'hybrid') return preferApi === false ? 'webui' : 'hybrid';
  if (adapter.apiCatalogStatus === 'ready') return 'webui';
  return 'api-discovery';
}

function catalogHint(adapter: ProductAdapter): string {
  if (adapter.apiCatalogStatus !== 'ready') return 'capture=webui_screenshot_and_network_discovery';
  if (adapter.product === 'HCI_SCP') return 'api_catalog=scp_openapi_v6.10/v6.1';
  if (adapter.product === 'IAG') return 'webui_catalog=iag_v1';
  if (adapter.product === 'ENDPOINT_SECURE') return 'webui_catalog=endpoint_secure_v1';
  if (adapter.product === 'NDR') return 'api_catalog=ndr_third_party_rest_v1';
  return 'catalog=ready';
}

function buildEvidenceHints(adapter: ProductAdapter, section: string, source: ConfigSource): string[] {
  const menu = adapter.capabilities.find(cap => cap.collectSections.includes(section))?.menuPath.join(' > ');
  const hints = [`section=${section}`, `source=${source}`];
  if (menu) hints.push(`menu=${menu}`);
  hints.push(catalogHint(adapter));
  return hints;
}

function taskFromRequirement(adapter: ProductAdapter, requirement: string, index: number): RequirementTask {
  const value = requirement.toLowerCase();
  const matched = bestCapability(adapter, value);
  const explicitApproval = requiresApprovalForText(requirement);
  const riskLevel = maxRisk(matched.riskLevel, explicitApproval.riskLevel);
  return {
    id: `task_${index + 1}`,
    product: adapter.product,
    requirement,
    capabilityId: matched.id,
    menuPath: matched.menuPath,
    apiEndpointCandidates: matched.apiEndpointCandidates,
    riskLevel,
    approvalRequired: matched.approvalRequired || explicitApproval.required || riskLevel === 'high' || riskLevel === 'critical',
    rationale: `${matched.title}; strategy=${adapter.strategy}; apiCatalog=${adapter.apiCatalogStatus}`
  };
}

function bestCapability(adapter: ProductAdapter, value: string): ProductCapability {
  const direct = directCapability(adapter, value);
  if (direct) return direct;
  const scored = adapter.capabilities.map((cap, index) => ({
    cap,
    index,
    score: cap.planKeywords.reduce((sum, keyword) => sum + (value.includes(keyword) ? keyword.length : 0), 0)
  }));
  scored.sort((a, b) => b.score - a.score || b.cap.riskLevel.localeCompare(a.cap.riskLevel) || a.index - b.index);
  return scored[0]?.score > 0 ? scored[0].cap : adapter.capabilities[0];
}

function directCapability(adapter: ProductAdapter, value: string): ProductCapability | undefined {
  const hasAny = (terms: string[]) => terms.some(term => value.includes(term));
  if (adapter.product === 'HCI_SCP' && hasAny(['drs', 'ha/drs', 'high availability', 'resource pool'])) {
    return adapter.capabilities.find(cap => cap.id === 'ha_drs');
  }
  if (adapter.product === 'ENDPOINT_SECURE' && hasAny(['deploy', 'deployment', 'install', 'rollout', '배포'])) {
    return adapter.capabilities.find(cap => cap.id === 'agent_deployment');
  }
  if (adapter.product === 'ENDPOINT_SECURE' && hasAny(['device control', 'usb', 'storage media', '저장매체'])) {
    return adapter.capabilities.find(cap => cap.id === 'device_control');
  }
  if (adapter.product === 'ENDPOINT_SECURE' && hasAny(['software control', 'unauthorized software', 'application control', 'app control', '소프트웨어'])) {
    return adapter.capabilities.find(cap => cap.id === 'app_control');
  }
  if (adapter.product === 'ENDPOINT_SECURE' && hasAny(['anti-virus', 'antivirus', 'malware', 'ransomware', 'engine update', 'scan', '검사', '엔진', '바이러스'])) {
    return adapter.capabilities.find(cap => cap.id === 'protection_policy');
  }
  if (adapter.product === 'ENDPOINT_SECURE' && hasAny(['log', 'event', 'audit', '보안 이벤트', '로그', '감사'])) {
    return adapter.capabilities.find(cap => cap.id === 'security_events');
  }
  if (adapter.product === 'NDR' && hasAny(['soar', 'playbook', 'response action', 'isolate', 'quarantine'])) {
    return adapter.capabilities.find(cap => cap.id === 'soar_response');
  }
  if (adapter.product === 'IAG' && hasAny(['ad ', 'ldap', 'authentication', 'auth source', 'sso'])) {
    return adapter.capabilities.find(cap => cap.id === 'auth_source');
  }
  if (adapter.product === 'IAG' && hasAny(['incident analysis and response', 'log retention', 'retained at least 1 year', 'retained for less than 1 year', 'audit log', 'event log'])) {
    return adapter.capabilities.find(cap => cap.id === 'log_validation');
  }
  if (adapter.product === 'IAG' && hasAny(['network access contro', 'network access control', 'nac', 'unauthorized external access', 'unauthorized device', 'network access', 'access control'])) {
    return adapter.capabilities.find(cap => cap.id === 'internet_policy');
  }
  return undefined;
}

interface ParsedSheet {
  name: string;
  rows: Map<number, Record<string, string>>;
}

interface ParsedWorkbook {
  sheets: ParsedSheet[];
}

interface ExcelRowNormalizeInput {
  rowNumber: number;
  no?: string;
  category?: string;
  solution?: string;
  item?: string;
  specificDetails?: string;
  inspectionResult: Record<string, string>;
  resultScore?: number;
  resultRaw?: string;
  reason?: string;
  assessmentCriteria?: string;
  remark?: string;
}

function readXlsxWorkbook(filePath: string): ParsedWorkbook {
  if (!filePath.toLowerCase().endsWith('.xlsx')) throw new Error(`Expected .xlsx file: ${filePath}`);
  const entries = unzipList(filePath);
  const sharedStrings = entries.includes('xl/sharedStrings.xml') ? parseSharedStrings(unzipText(filePath, 'xl/sharedStrings.xml')) : [];
  const relationships = parseWorkbookRelationships(unzipText(filePath, 'xl/_rels/workbook.xml.rels'));
  const sheets = parseWorkbookSheets(unzipText(filePath, 'xl/workbook.xml'), relationships)
    .map(sheet => ({
      name: sheet.name,
      rows: parseWorksheetRows(unzipText(filePath, sheet.path), sharedStrings)
    }));
  return { sheets };
}

function unzipList(filePath: string): string[] {
  return execFileSync('unzip', ['-Z1', filePath], { encoding: 'utf8' })
    .split(/\r?\n/)
    .map(entry => entry.trim())
    .filter(Boolean);
}

function unzipText(filePath: string, entry: string): string {
  return execFileSync('unzip', ['-p', filePath, entry], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function parseSharedStrings(xml: string): string[] {
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)]
    .map(match => xmlText(match[1]));
}

function parseWorkbookRelationships(xml: string): Record<string, string> {
  const relationships: Record<string, string> = {};
  for (const match of xml.matchAll(/<Relationship\b([^>]*)\/>/g)) {
    const id = attr(match[1], 'Id');
    const target = attr(match[1], 'Target');
    if (id && target) relationships[id] = target.startsWith('xl/') ? target : `xl/${target.replace(/^\//, '')}`;
  }
  return relationships;
}

function parseWorkbookSheets(xml: string, relationships: Record<string, string>): Array<{ name: string; path: string }> {
  return [...xml.matchAll(/<sheet\b([^>]*)\/>/g)]
    .map(match => {
      const name = attr(match[1], 'name') ?? 'Sheet';
      const relationshipId = attr(match[1], 'r:id');
      const path = relationshipId ? relationships[relationshipId] : undefined;
      if (!path) throw new Error(`Workbook sheet relationship not found: ${name}`);
      return { name, path };
    });
}

function parseWorksheetRows(xml: string, sharedStrings: string[]): Map<number, Record<string, string>> {
  const rows = new Map<number, Record<string, string>>();
  for (const rowMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowNumber = Number(attr(rowMatch[1], 'r'));
    if (!Number.isFinite(rowNumber)) continue;
    const row: Record<string, string> = {};
    for (const cellMatch of parseCells(rowMatch[2])) {
      const ref = attr(cellMatch.attrs, 'r');
      if (!ref) continue;
      const column = ref.match(/[A-Z]+/)?.[0];
      if (!column) continue;
      const type = attr(cellMatch.attrs, 't');
      const raw = cellMatch.body;
      const valueMatch = raw.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
      let value = valueMatch ? decodeXml(valueMatch[1]) : xmlText(raw);
      if (type === 's' && value !== '') value = sharedStrings[Number(value)] ?? value;
      row[column] = normalizeWhitespace(value);
    }
    rows.set(rowNumber, row);
  }
  return rows;
}

function parseCells(rowXml: string): Array<{ attrs: string; body: string }> {
  const cells: Array<{ attrs: string; body: string }> = [];
  const cellRegex = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  for (const match of rowXml.matchAll(cellRegex)) {
    cells.push({ attrs: match[1], body: match[2] ?? '' });
  }
  return cells;
}

function findChecklistHeaderRow(rows: Map<number, Record<string, string>>): number | undefined {
  for (const [rowNumber, row] of rows) {
    const values = Object.values(row).map(value => normalizeHeader(value));
    if (values.includes('no') && values.includes('category') && values.includes('item') && values.includes('specificdetails')) {
      return rowNumber;
    }
  }
  return undefined;
}

function mergeHeaderRows(parentHeader: Record<string, string>, header: Record<string, string>): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const column of unique([...Object.keys(parentHeader), ...Object.keys(header)])) {
    merged[column] = header[column] || parentHeader[column] || '';
  }
  return merged;
}

function cellByHeader(cells: Record<string, string>, header: Record<string, string>, names: string[]): string | undefined {
  const wanted = names.map(normalizeHeader);
  const column = Object.entries(header).find(([, value]) => wanted.includes(normalizeHeader(value)))?.[0];
  const value = column ? cells[column] : undefined;
  return value || undefined;
}

function inspectionResultsFromRow(cells: Record<string, string>, header: Record<string, string>): Record<string, string> {
  const ignored = new Set(['no', 'category', 'soultion', 'solution', 'item', 'specificdetails', 'results', 'reasonforinspectionresults', 'assessmentcriteria', 'remark']);
  const result: Record<string, string> = {};
  for (const [column, headerValue] of Object.entries(header)) {
    const normalized = normalizeHeader(headerValue);
    if (!headerValue || ignored.has(normalized)) continue;
    const value = cells[column];
    if (value) result[headerValue] = value;
  }
  return result;
}

function normalizeExcelRow(input: ExcelRowNormalizeInput): ExcelRequirementRow {
  const inspectionValues = Object.values(input.inspectionResult);
  const isPartial = inspectionValues.some(value => value.includes('△'));
  const hasGap = Boolean(input.reason?.trim());
  const lowScore = typeof input.resultScore === 'number' && input.resultScore < 1;
  const priority: ExcelRequirementRow['priority'] = isPartial || lowScore
    ? 'high'
    : hasGap
      ? 'medium'
      : 'low';
  const requirement = [input.solution, input.item, input.specificDetails].filter(Boolean).join(' | ');
  const currentGap = input.reason || (isPartial ? `Inspection result includes partial status: ${inspectionValues.join(', ')}` : '');
  const targetControl = input.assessmentCriteria || input.specificDetails || requirement;
  return {
    rowNumber: input.rowNumber,
    rowId: `excel_row_${input.rowNumber}`,
    no: input.no,
    category: input.category,
    solution: input.solution,
    item: input.item,
    specificDetails: input.specificDetails,
    inspectionResult: input.inspectionResult,
    resultScore: input.resultScore,
    resultRaw: input.resultRaw,
    reason: input.reason,
    assessmentCriteria: input.assessmentCriteria,
    remark: input.remark,
    requirement,
    evidenceNeed: evidenceNeedsForText(`${requirement} ${targetControl}`),
    targetControl,
    currentGap,
    priority
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

function evidenceNeedsForText(text: string): string[] {
  const value = text.toLowerCase();
  const needs = [...DEFAULT_EVIDENCE_NEEDS];
  if (hasAny(value, ['log', 'event'])) needs.push('log retention/export evidence');
  if (hasAny(value, ['agent', 'endpoint', 'edr', 'antivirus'])) needs.push('endpoint agent inventory and update status');
  if (hasAny(value, ['policy', 'url', 'application', 'auth'])) needs.push('policy/auth configuration screenshot');
  if (hasAny(value, ['incident', 'alert', 'soar'])) needs.push('incident/alert/playbook evidence');
  return unique(needs);
}

function requiredFilePath(filePath?: string): string {
  if (!filePath) throw new Error('filePath is required when rows are not provided.');
  return filePath;
}

function isExcelBasedChangePlan(plan: ProductChangePlan | ExcelBasedChangePlan): plan is ExcelBasedChangePlan {
  return 'source' in plan && plan.source === 'excel';
}

function taskIdentifier(task: RequirementTask | MappedRequirement): string {
  return 'id' in task ? task.id : task.rowId;
}

function attr(xmlAttrs: string, name: string): string | undefined {
  const escapedName = name.replace(':', String.raw`\:`);
  const match = xmlAttrs.match(new RegExp(`\\b${escapedName}="([^"]*)"`));
  return match ? decodeXml(match[1]) : undefined;
}

function xmlText(xml: string): string {
  return normalizeWhitespace(decodeXml(xml.replace(/<[^>]+>/g, ' ')));
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').trim();
}

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9가-힣]+/g, '');
}

function parseOptionalNumber(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function hasAny(value: string, terms: string[]): boolean {
  return terms.some(term => value.includes(term));
}

function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  const order: RiskLevel[] = ['low', 'medium', 'high', 'critical'];
  return order[Math.max(order.indexOf(a), order.indexOf(b))];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function missingApprovalFields(approval?: ApprovalPayload): string[] {
  const fields: Array<keyof ApprovalPayload> = ['approvedBy', 'approvalToken', 'changeTicketId', 'rollbackPlanId'];
  return fields.filter(field => !approval?.[field]);
}
