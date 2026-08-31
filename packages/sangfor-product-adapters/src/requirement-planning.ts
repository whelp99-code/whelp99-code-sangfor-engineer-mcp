import { requiresApprovalForText } from '@sangfor/approval';
import { nowId } from '@sangfor/shared';
import type { RiskLevel } from '@sangfor/shared';
import { getProductAdapter } from './source-mapping.js';
import type {
  ProductAdapter,
  ProductCapability,
  ProductChangePlan,
  RequirementAnalysisInput,
  RequirementTask,
} from './types.js';

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

export function bestCapability(adapter: ProductAdapter, value: string): ProductCapability {
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


function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  const order: RiskLevel[] = ['low', 'medium', 'high', 'critical'];
  return order[Math.max(order.indexOf(a), order.indexOf(b))];
}
