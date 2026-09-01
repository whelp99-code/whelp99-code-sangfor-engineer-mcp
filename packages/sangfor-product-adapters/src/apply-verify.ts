import { requiresApprovalForText } from '@sangfor/approval';
import { readLiveConsoleState } from '@sangfor/operator';
import { nowId } from '@sangfor/shared';
import type { BrowserExecutionPort } from '../../sangfor-browser-contracts/src/index.js';
import type {
  ApprovalPayload,
  ExcelBasedChangePlan,
  MappedRequirement,
  ProductChangeExecutor,
  ProductChangePlan,
  RequirementTask,
} from './types.js';

export async function dryRunProductChange(input: { plan: ProductChangePlan | ExcelBasedChangePlan; targetUrl?: string; sessionId?: string; browserExecutionPort?: BrowserExecutionPort }) {
  const excelPlan = isExcelBasedChangePlan(input.plan) ? input.plan : undefined;
  const operatorState = input.sessionId ? await readLiveConsoleState({
    sessionId: input.sessionId,
    executionPort: input.browserExecutionPort,
  }) : undefined;
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

export async function applyApprovedProductChange(input: { plan: ProductChangePlan; approval?: ApprovalPayload; environment?: 'lab' | 'poc' | 'customer' | 'production'; sessionId?: string; executor?: ProductChangeExecutor; browserExecutionPort?: BrowserExecutionPort }) {
  const missingApproval = missingApprovalFields(input.approval);
  const highRiskTasks = input.plan.tasks.filter(task => task.approvalRequired || requiresApprovalForText(`${task.requirement} ${task.capabilityId}`).required);
  if (highRiskTasks.length > 0 && missingApproval.length > 0) {
    return {
      id: nowId('apply'), ok: false, code: 'LEGACY_PRODUCT_APPLY_DEPRECATED',
      approvalRequired: true, mutationPerformed: false,
      reason: `Missing approval payload fields: ${missingApproval.join(', ')}`,
    };
  }
  if (process.env.SANGFOR_ALLOW_REAL_EXECUTION !== 'true') {
    return {
      id: nowId('apply'), ok: false, code: 'LEGACY_PRODUCT_APPLY_DEPRECATED',
      approvalRequired: highRiskTasks.length > 0, mutationPerformed: false,
      reason: 'SANGFOR_ALLOW_REAL_EXECUTION=true is required for real changes.',
    };
  }
  if (input.environment === 'production' && process.env.SANGFOR_ALLOW_PRODUCTION_EXECUTION !== 'true') {
    return {
      id: nowId('apply'), ok: false, code: 'LEGACY_PRODUCT_APPLY_DEPRECATED',
      approvalRequired: true, mutationPerformed: false,
      reason: 'SANGFOR_ALLOW_PRODUCTION_EXECUTION=true is required for production changes.',
    };
  }
  return {
    id: nowId('apply'), ok: false, code: 'LEGACY_PRODUCT_APPLY_DEPRECATED',
    approvalRequired: highRiskTasks.length > 0, mutationPerformed: false,
    reason: 'Legacy product apply cannot execute. Use the verified product-specific orchestrator.',
    approvedBy: input.approval?.approvedBy,
    changeTicketId: input.approval?.changeTicketId,
  };
}

export function verifyProductChange(input: { plan: ProductChangePlan; observed?: Record<string, unknown> }) {
  const checks = input.plan.tasks.map(task => {
    const observed = input.observed?.[task.id] ?? null;
    let status: 'PASS' | 'FAIL' | 'INDETERMINATE' = 'INDETERMINATE';
    if (typeof observed === 'object' && observed !== null) {
      const candidate = Reflect.get(observed, 'status');
      if (candidate === 'PASS' || candidate === 'FAIL' || candidate === 'INDETERMINATE') status = candidate;
    }
    return {
      taskId: task.id, requirement: task.requirement, menuPath: task.menuPath,
      expectedEvidence: ['post-change config snapshot', 'task/audit log', 'alert/log verification', 'before-after comparison'],
      observed, status,
    };
  });
  const aggregate = checks.some(({ status }) => status === 'FAIL')
    ? 'FAIL' as const
    : checks.length > 0 && checks.every(({ status }) => status === 'PASS')
      ? 'PASS' as const
      : 'INDETERMINATE' as const;
  return {
    id: nowId('verify'), product: input.plan.product, ok: aggregate === 'PASS', aggregate,
    readOnly: true, checks,
    evidenceStatus: aggregate === 'PASS' ? 'verified_pass' : aggregate === 'FAIL' ? 'verified_fail' : 'indeterminate',
  };
}

function isExcelBasedChangePlan(plan: ProductChangePlan | ExcelBasedChangePlan): plan is ExcelBasedChangePlan {
  return 'source' in plan && plan.source === 'excel';
}

function taskIdentifier(task: RequirementTask | MappedRequirement): string {
  return 'id' in task ? task.id : task.rowId;
}

function missingApprovalFields(approval?: ApprovalPayload): string[] {
  const fields: Array<keyof ApprovalPayload> = ['approvedBy', 'approvalToken', 'changeTicketId', 'rollbackPlanId'];
  return fields.filter(field => !approval?.[field]);
}
