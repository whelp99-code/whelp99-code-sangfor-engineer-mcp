import { searchManuals } from '@sangfor/knowledge';
import { searchWiki } from '@sangfor/wiki';
import { classifyTextRisk } from '@sangfor/approval';
import {
  ConfigPlan,
  ConfigStep,
  KnowledgeChunk,
  ProductCode,
  ProjectAnalysis,
  ProjectInput,
  ProjectType,
  normalizeProduct,
  nowId
} from '@sangfor/shared';

function inferProjectType(input: ProjectInput): ProjectType {
  const text = `${input.projectType ?? ''} ${(input.requirements ?? []).join(' ')} ${JSON.stringify(input.environment ?? {})}`.toLowerCase();
  if (text.includes('dr') || text.includes('failover')) return 'dr';
  if (text.includes('migration') || text.includes('p2v') || text.includes('vmware')) return 'migration';
  if (text.includes('poc')) return 'poc';
  if (text.includes('troubleshooting') || text.includes('장애')) return 'troubleshooting';
  if (text.includes('policy')) return 'policy_design';
  if (text.includes('monitoring') || text.includes('event')) return 'monitoring';
  return 'deployment';
}

export function analyzeProject(input: ProjectInput): ProjectAnalysis {
  const product = normalizeProduct(input.product);
  const projectType = inferProjectType(input);
  const environment = input.environment ?? {};
  const missingInputs: string[] = [];

  if (product === 'HCI') {
    for (const key of ['nodeCount', 'managementNetwork', 'storageNetwork', 'licenseStatus']) {
      if (!(key in environment)) missingInputs.push(key);
    }
  }
  if (product === 'IAG') {
    for (const key of ['userSource', 'authMethod', 'policyScope', 'loggingRequirement']) {
      if (!(key in environment)) missingInputs.push(key);
    }
  }
  if (product === 'ENDPOINT_SECURE') {
    for (const key of ['endpointCount', 'osMix', 'deploymentMethod', 'pilotGroup']) {
      if (!(key in environment)) missingInputs.push(key);
    }
  }
  if (product === 'CYBER_COMMAND') {
    for (const key of ['eventSources', 'collectorNetwork', 'ntpStatus', 'reportRecipients']) {
      if (!(key in environment)) missingInputs.push(key);
    }
  }

  const riskText = `${product} ${projectType} ${(input.requirements ?? []).join(' ')}`;
  const riskLevel = classifyTextRisk(riskText);

  return {
    customerName: input.customerName,
    detectedProduct: product,
    detectedVersion: input.version,
    projectType,
    riskLevel,
    missingInputs,
    assumptions: [
      'MVP uses document/wiki mock search until official/internal manuals are uploaded.',
      'Console operation is dry-run only until lab validation is completed.',
      'Credentials, OTP, MFA, license keys and customer secrets must be entered by humans and not stored.'
    ],
    recommendedKnowledgeQueries: buildKnowledgeQueries(product, projectType)
  };
}

function buildKnowledgeQueries(product: ProductCode, projectType: ProjectType): string[] {
  const base: Record<ProductCode, string[]> = {
    HCI: ['cluster initialization precheck', 'storage network MTU', 'VM migration rollback', 'DR failover validation'],
    IAG: ['access policy design', 'authentication integration', 'internet access control logging', 'policy rollback'],
    ENDPOINT_SECURE: ['agent deployment pilot group', 'EDR policy baseline', 'exception policy', 'rollback uninstall package'],
    CYBER_COMMAND: ['event source onboarding', 'NTP validation', 'alert rule mapping', 'dashboard report validation']
  };
  return base[product].map(query => `${query} ${projectType}`);
}

function step(product: ProductCode, phase: ConfigStep['phase'], title: string, description: string, approvalRequired = false, references: KnowledgeChunk[] = []): ConfigStep {
  return {
    id: nowId('step'),
    product,
    phase,
    title,
    description,
    approvalRequired,
    riskLevel: approvalRequired ? 'high' : classifyTextRisk(`${title} ${description}`),
    references: references.map(ref => ref.id)
  };
}

export function generateConfigPlan(input: ProjectInput): ConfigPlan {
  const analysis = analyzeProject(input);
  const manualReferences = searchManuals({ product: analysis.detectedProduct, version: input.version, query: analysis.recommendedKnowledgeQueries.join(' '), limit: 5 });
  const wikiReferences = searchWiki({ product: analysis.detectedProduct, version: input.version, query: analysis.recommendedKnowledgeQueries.join(' '), limit: 5 });
  const references = [...manualReferences, ...wikiReferences];

  const precheck: ConfigStep[] = [];
  const steps: ConfigStep[] = [];
  const validationPlan: ConfigStep[] = [];
  const rollbackPlan: ConfigStep[] = [];

  if (analysis.detectedProduct === 'HCI') {
    precheck.push(
      step('HCI', 'precheck', 'Confirm node and license readiness', 'Verify node count, serial/license status, management IPs, DNS/NTP, and hardware health.', false, references),
      step('HCI', 'precheck', 'Validate management and storage networks', 'Verify management reachability, storage network isolation, NIC mapping, link speed, VLAN and MTU consistency.', false, references),
      step('HCI', 'precheck', 'Confirm source VM migration readiness', 'For VMware/Hyper-V/Nutanix source environments, confirm VM inventory, backup state, network mapping, and rollback window.', false, references)
    );
    steps.push(
      step('HCI', 'configure', 'Prepare cluster configuration draft', 'Prepare cluster name, node IP mapping, storage pool design, and VM network mapping in dry-run mode.', false, references),
      step('HCI', 'configure', 'Apply cluster/network configuration', 'Apply HCI cluster and network settings only after human approval.', true, references),
      step('HCI', 'configure', 'Start migration or DR workflow', 'Start VM migration, replication, failover rehearsal, or production cutover only after explicit approval.', true, references)
    );
    validationPlan.push(
      step('HCI', 'validate', 'Validate cluster health', 'Check cluster status, node status, storage pool status, alarms, and NTP synchronization.', false, references),
      step('HCI', 'validate', 'Validate VM network and migration result', 'Confirm VM connectivity, IP mapping, application check, and rollback readiness.', false, references)
    );
    rollbackPlan.push(
      step('HCI', 'rollback', 'Return to previous source platform state', 'Keep source VM unchanged until final cutover and restore DNS/routing if validation fails.', true, references)
    );
  }

  if (analysis.detectedProduct === 'IAG') {
    precheck.push(
      step('IAG', 'precheck', 'Collect user, group and authentication source', 'Confirm AD/LDAP/local user source, group mapping, authentication method, and exception accounts.', false, references),
      step('IAG', 'precheck', 'Export current policy and logging settings', 'Capture current IAG policy, routing, and logging state before changes.', false, references)
    );
    steps.push(
      step('IAG', 'configure', 'Draft access policy set', 'Create draft rules for user/group, URL category, application control, time schedule, logging and exception policy.', false, references),
      step('IAG', 'configure', 'Apply access control policy', 'Apply access policy only after approval because it can block users from internet access.', true, references)
    );
    validationPlan.push(step('IAG', 'validate', 'Validate user access and logs', 'Test allowed/blocked traffic, authentication, log visibility, bypass account and rollback policy.', false, references));
    rollbackPlan.push(step('IAG', 'rollback', 'Restore exported policy', 'Rollback to exported policy if critical business access is blocked.', true, references));
  }

  if (analysis.detectedProduct === 'ENDPOINT_SECURE') {
    precheck.push(
      step('ENDPOINT_SECURE', 'precheck', 'Confirm endpoint inventory and pilot group', 'Verify OS versions, endpoint count, pilot users, server reachability and exception requirements.', false, references),
      step('ENDPOINT_SECURE', 'precheck', 'Confirm policy baseline and rollback package', 'Prepare AV/EDR baseline policy, exception policy, uninstall package and staged rollout group.', false, references)
    );
    steps.push(
      step('ENDPOINT_SECURE', 'configure', 'Prepare agent deployment policy', 'Create deployment group and policy draft for pilot rollout.', false, references),
      step('ENDPOINT_SECURE', 'configure', 'Deploy agent to pilot group', 'Deploy agent only after approval because endpoint performance and user work may be affected.', true, references)
    );
    validationPlan.push(step('ENDPOINT_SECURE', 'validate', 'Validate agent and detection status', 'Check agent online status, policy applied status, update status, detection logs and false positive report.', false, references));
    rollbackPlan.push(step('ENDPOINT_SECURE', 'rollback', 'Uninstall or policy rollback', 'Use prepared uninstall or relaxed policy package if business impact is observed.', true, references));
  }

  if (analysis.detectedProduct === 'CYBER_COMMAND') {
    precheck.push(
      step('CYBER_COMMAND', 'precheck', 'Confirm event sources and time sync', 'Verify event source list, collector network, NTP/timezone consistency, log volume and retention requirement.', false, references),
      step('CYBER_COMMAND', 'precheck', 'Confirm monitoring use case', 'Define alert rules, dashboard scope, report recipients and incident response workflow.', false, references)
    );
    steps.push(
      step('CYBER_COMMAND', 'configure', 'Prepare event collection mapping', 'Draft event source onboarding, parser mapping and dashboard/report plan.', false, references),
      step('CYBER_COMMAND', 'configure', 'Enable alerting/report workflow', 'Enable alerting and reporting only after approval because it may trigger operational notifications.', true, references)
    );
    validationPlan.push(step('CYBER_COMMAND', 'validate', 'Validate event collection and dashboard', 'Confirm event ingestion, correlation, dashboard widgets, alert firing and report delivery.', false, references));
    rollbackPlan.push(step('CYBER_COMMAND', 'rollback', 'Disable new alert/report rules', 'Disable newly created rules and reports if noise or wrong notifications occur.', true, references));
  }

  return {
    id: nowId('plan'),
    customerName: input.customerName,
    product: analysis.detectedProduct,
    version: input.version,
    planTitle: `${analysis.detectedProduct} ${analysis.projectType} configuration plan for ${input.customerName}`,
    planSummary: `Generated senior-engineer style plan with precheck, approval gates, rollback and validation for ${analysis.detectedProduct}.`,
    riskLevel: analysis.riskLevel,
    precheck,
    steps,
    approvalRequiredSteps: [...precheck, ...steps, ...validationPlan, ...rollbackPlan].filter(s => s.approvalRequired),
    rollbackPlan,
    validationPlan,
    manualReferences,
    wikiReferences,
    lessonReferences: []
  };
}

export function validateConfigPlan(plan: ConfigPlan): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (plan.precheck.length === 0) errors.push('precheck is required');
  if (plan.steps.length === 0) errors.push('steps are required');
  if (plan.rollbackPlan.length === 0) errors.push('rollbackPlan is required');
  if (plan.validationPlan.length === 0) errors.push('validationPlan is required');
  if (plan.manualReferences.length + plan.wikiReferences.length === 0) errors.push('manual or wiki references are required');
  return { ok: errors.length === 0, errors };
}
