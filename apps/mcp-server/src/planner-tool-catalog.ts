import { analyzeProject, generateConfigPlanAsync, validateConfigPlan } from '../../../packages/sangfor-planner/src/index.js';
import { plans } from './domain-session-state.js';
import { persistConfigPlan } from '../../../packages/sangfor-store/src/index.js';
import { requiresApprovalForText } from '../../../packages/sangfor-approval/src/index.js';
import type { ToolCatalogEntry } from './mcp-contracts.js';

export const plannerToolCatalog: readonly ToolCatalogEntry[] = [
  ["sangfor_analyze_project", {
    description: 'Analyze customer project input and return product, project type, risk, missing inputs and knowledge queries.',
    inputSchema: { type: 'object', properties: { customerName: { type: 'string' }, product: { type: 'string' }, version: { type: 'string' }, projectType: { type: 'string' }, environment: { type: 'object' }, requirements: { type: 'array', items: { type: 'string' } } }, required: ['customerName'] },
    handler: analyzeProject
  }],
  ["sangfor_generate_config_plan", {
    description: 'Generate a configuration plan with precheck, steps, rollback, validation and approval gates.',
    inputSchema: { type: 'object', properties: { customerName: { type: 'string' }, product: { type: 'string' }, version: { type: 'string' }, projectType: { type: 'string' }, environment: { type: 'object' }, requirements: { type: 'array', items: { type: 'string' } } }, required: ['customerName', 'product'] },
    handler: async (args: Parameters<typeof generateConfigPlanAsync>[0]) => {
      const plan = await generateConfigPlanAsync(args);
      plans.set(plan.id, plan);
      const dbId = await persistConfigPlan(plan).catch(() => null);
      return dbId ? { ...plan, persistedId: dbId } : plan;
    }
  }],
  ["sangfor_validate_config_plan", {
    description: 'Validate that a generated plan has precheck, steps, rollback, validation and references.',
    inputSchema: { type: 'object', properties: { planId: { type: 'string' }, plan: { type: 'object' } } },
    handler: ({ planId, plan }) => validateConfigPlan(plan ?? plans.get(planId))
  }],
  ["sangfor_request_approval", {
    description: 'Classify text/action risk and return approval decision.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    handler: ({ text }) => requiresApprovalForText(text)
  }],
];
