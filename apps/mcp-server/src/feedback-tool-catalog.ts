import { plans } from './domain-session-state.js';
import { generateEvidenceReport } from '../../../packages/sangfor-evidence/src/index.js';
import { submitFeedback, extractLesson } from '../../../packages/sangfor-feedback/src/index.js';
import { evalRoot, mcpLocalAuthority, wikiRoot } from './authority-path-support.js';
import { feedbackRoot } from './search-gap-support.js';
import { persistFeedbackEvent } from '../../../packages/sangfor-store/src/index.js';
import { proposeWikiUpdate, approveWikiUpdate, applyWikiUpdate, applyObsidianWikiUpdate, applyGitHubWikiUpdate } from '../../../packages/sangfor-wiki/src/index.js';
import { createEvalCaseFromFeedback, runPlannerEval } from '../../../packages/sangfor-evals/src/index.js';
import { createFineTuneDataset, validateFineTuneDataset, createFineTuneJobSpec } from '../../../packages/sangfor-finetune/src/index.js';
import type { ToolCatalogEntry } from './mcp-contracts.js';

export const feedbackToolCatalog: readonly ToolCatalogEntry[] = [
  ["sangfor_generate_evidence_report", {
    description: 'Generate Markdown evidence report for a plan.',
    inputSchema: { type: 'object', properties: { planId: { type: 'string' }, plan: { type: 'object' }, verification: { type: 'object' }, format: { type: 'string' } } },
    handler: ({ planId, plan, verification, format }) => {
      const rawPlan = plan ?? plans.get(planId);
      // Excel plans have workPlan instead of ConfigPlan fields — normalize
      const normalizedPlan = rawPlan?.workPlan ? {
        id: rawPlan.id ?? planId ?? 'unknown',
        product: rawPlan.product ?? 'MULTI_PRODUCT',
        planTitle: rawPlan.summary ?? 'Excel-based plan',
        planSummary: rawPlan.summary ?? '',
        customerName: '',
        riskLevel: 'medium',
        approvalRequiredSteps: [],
        manualReferences: [],
        wikiReferences: [],
        lessonReferences: [],
        steps: (rawPlan.workPlan ?? []).filter((w: any) => w.product !== 'external_or_manual').map((w: any) => ({ id: w.requestId, title: w.setting, description: w.description, product: w.product, phase: 'config' as const, approvalRequired: false, riskLevel: 'low' as any, references: [] })),
        precheck: [],
        rollbackPlan: [],
        validationPlan: (rawPlan.workPlan ?? []).map((w: any) => ({ id: w.requestId, title: w.setting, description: w.description, product: w.product, phase: 'validation' as const, approvalRequired: false, riskLevel: 'low' as any, references: [] })),
      } : rawPlan;
      return generateEvidenceReport({ plan: normalizedPlan, verification, format });
    }
  }],
  ["sangfor_submit_feedback", {
    description: 'Submit feedback linked to a product/plan/session.',
    inputSchema: { type: 'object', properties: { product: { type: 'string' }, feedbackType: { type: 'string' }, severity: { type: 'string' }, feedbackText: { type: 'string' }, sourceRole: { type: 'string' } }, required: ['product', 'feedbackType', 'severity', 'feedbackText', 'sourceRole'] },
    handler: async (args: Parameters<typeof submitFeedback>[0]) => {
      const event = await submitFeedback(args, mcpLocalAuthority('feedback_lessons', feedbackRoot()));
      const dbId = await persistFeedbackEvent(event).catch(() => null);
      return dbId ? { ...event, persistedId: dbId } : event;
    }
  }],
  ["sangfor_extract_lesson", {
    description: 'Extract a lesson learned from feedback.',
    inputSchema: { type: 'object', properties: { feedbackId: { type: 'string' } }, required: ['feedbackId'] },
    handler: ({ feedbackId }) => extractLesson(feedbackId, mcpLocalAuthority('feedback_lessons', feedbackRoot()))
  }],
  ["sangfor_propose_wiki_update", {
    description: 'Create a wiki update proposal from a lesson. Does not directly modify wiki. Creates a pending_review proposal only; applying it requires explicit human approval (reviewer token). Requires explicit reviewer consent before any wiki change.',
    inputSchema: { type: 'object', properties: { lessonTitle: { type: 'string' }, lessonBody: { type: 'string' }, targetPage: { type: 'string' } }, required: ['lessonTitle', 'lessonBody'] },
    handler: (input: Parameters<typeof proposeWikiUpdate>[0]) => proposeWikiUpdate(input, mcpLocalAuthority('wiki_proposals', wikiRoot()))
  }],
  ["sangfor_approve_wiki_update", {
    description: 'Approve or reject a wiki update proposal. Requires explicit reviewer token to confirm the approve/reject decision.',
    inputSchema: { type: 'object', properties: { proposalId: { type: 'string' }, decision: { type: 'string' }, token: { type: 'string' }, reviewer: { type: 'string' } }, required: ['proposalId', 'decision'] },
    handler: ({ proposalId, decision, token, reviewer }) => approveWikiUpdate(proposalId, decision, { token, reviewer }, mcpLocalAuthority('wiki_proposals', wikiRoot()))
  }],
  ["sangfor_apply_wiki_update", {
    description: 'Apply an approved wiki update proposal. Blocks pending proposals. Gated by explicit human approval: applies only proposals that passed review; pending proposals are blocked.',
    inputSchema: { type: 'object', properties: { proposalId: { type: 'string' } }, required: ['proposalId'] },
    handler: ({ proposalId }) => applyWikiUpdate(proposalId, mcpLocalAuthority('wiki_proposals', wikiRoot()))
  }],
  ["sangfor_apply_obsidian_wiki_update", {
    description: 'Apply an approved wiki update proposal to an Obsidian vault path. Gated by explicit human approval: applies only proposals that passed review; pending proposals are blocked.',
    inputSchema: { type: 'object', properties: { proposalId: { type: 'string' }, vaultPath: { type: 'string' } }, required: ['proposalId', 'vaultPath'] },
    handler: ({ proposalId, vaultPath }) => applyObsidianWikiUpdate({
      proposalId, vaultPath, proposalAuthority: mcpLocalAuthority('wiki_proposals', wikiRoot()),
      adapterAuthority: mcpLocalAuthority('wiki_proposals', vaultPath),
    })
  }],
  ["sangfor_apply_github_wiki_update", {
    description: 'Apply an approved wiki update proposal to a GitHub Wiki git repository. Uses git CLI and provided repoUrl/localPath. Gated by explicit human approval: applies only proposals that passed review; pending proposals are blocked.',
    inputSchema: { type: 'object', properties: { proposalId: { type: 'string' }, repoUrl: { type: 'string' }, localPath: { type: 'string' } }, required: ['proposalId', 'repoUrl'] },
    handler: ({ proposalId, repoUrl, localPath }) => {
      const targetRoot = localPath ?? 'data/wiki/github-wiki';
      return applyGitHubWikiUpdate({
        proposalId, repoUrl, localPath: targetRoot, proposalAuthority: mcpLocalAuthority('wiki_proposals', wikiRoot()),
        adapterAuthority: mcpLocalAuthority('wiki_proposals', targetRoot),
      });
    }
  }],
  ["sangfor_create_eval_case_from_feedback", {
    description: 'Create planner regression eval case from feedback. Local-only evals-store write; requires explicit product, name and requiredText, and never touches a device.',
    inputSchema: { type: 'object', properties: { product: { type: 'string' }, name: { type: 'string' }, requiredText: { type: 'string' } }, required: ['product', 'name', 'requiredText'] },
    handler: (input: Parameters<typeof createEvalCaseFromFeedback>[0]) => createEvalCaseFromFeedback(input, mcpLocalAuthority('evals', evalRoot()))
  }],
  ["sangfor_create_finetune_dataset", {
    description: 'Create JSONL fine-tuning dataset from reviewed Sangfor examples. Blocks secrets during validation step. Local-only dataset write; requires explicit examples and blocks secrets during validation.',
    inputSchema: { type: 'object', properties: { product: { type: 'string' }, taskType: { type: 'string' }, examples: { type: 'array' }, outputPath: { type: 'string' } }, required: ['product', 'taskType', 'examples'] },
    handler: createFineTuneDataset
  }],
  ["sangfor_validate_finetune_dataset", {
    description: 'Validate JSONL fine-tuning dataset for structure and obvious sensitive data.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    handler: ({ path }) => validateFineTuneDataset(path)
  }],
  ["sangfor_create_finetune_job_spec", {
    description: 'Create a reviewed fine-tuning job manifest. Does not submit automatically. Local-only manifest write; does not submit — running a job requires explicit external action.',
    inputSchema: { type: 'object', properties: { provider: { type: 'string' }, baseModel: { type: 'string' }, datasetPath: { type: 'string' }, validationDatasetPath: { type: 'string' }, product: { type: 'string' }, taskType: { type: 'string' } }, required: ['datasetPath', 'product', 'taskType'] },
    handler: createFineTuneJobSpec
  }],
  ["sangfor_run_planner_eval", {
    description: 'Run built-in planner evals against a generated config plan.',
    inputSchema: { type: 'object', properties: { planId: { type: 'string' }, plan: { type: 'object' } } },
    handler: ({ planId, plan }) => runPlannerEval(plan ?? plans.get(planId))
  }],
];
