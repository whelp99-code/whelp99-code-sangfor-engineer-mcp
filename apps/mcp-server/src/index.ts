import readline from 'node:readline';
import { analyzeProject, generateConfigPlan, generateConfigPlanAsync, validateConfigPlan } from '../../../packages/sangfor-planner/src/index.js';
import { searchManuals, getManualSection } from '../../../packages/sangfor-knowledge/src/index.js';
import { searchWiki, proposeWikiUpdate, approveWikiUpdate, applyWikiUpdate, applyObsidianWikiUpdate, applyGitHubWikiUpdate } from '../../../packages/sangfor-wiki/src/index.js';
import { requiresApprovalForText } from '../../../packages/sangfor-approval/src/index.js';
import { startOperatorSession, readConsoleState, executeConsoleAction, readLiveConsoleState, executeLiveConsoleAction, killSession } from '../../../packages/sangfor-operator/src/index.js';
import { verifyResult } from '../../../packages/sangfor-verifier/src/index.js';
import { generateEvidenceReport } from '../../../packages/sangfor-evidence/src/index.js';
import { submitFeedback, extractLesson } from '../../../packages/sangfor-feedback/src/index.js';
import { createEvalCaseFromFeedback, runPlannerEval } from '../../../packages/sangfor-evals/src/index.js';
import { PRODUCTS } from '../../../packages/shared/src/index.js';
import { ingestDocument, ragSearch, exportRagIndexSummary } from '../../../packages/sangfor-rag/src/index.js';
import { createFineTuneDataset, createFineTuneJobSpec, validateFineTuneDataset } from '../../../packages/sangfor-finetune/src/index.js';
import { loadEnvFile } from '../../../packages/sangfor-collector/src/load-env.js';
import { runLearnSourcesPipeline } from '../../../packages/sangfor-collector/src/learn-pipeline.js';
import { persistConfigPlan, persistFeedbackEvent, storeHealthCheck } from '../../../packages/sangfor-store/src/index.js';
import {
  analyzeCustomerRequirements,
  applyApprovedProductChange,
  collectProductConfig,
  discoverProductConsole,
  dryRunProductChange,
  generateExcelBasedChangePlan,
  generateProductChangePlan,
  importExcelRequirementList,
  mapRequirementsToProducts,
  verifyProductChange
} from '../../../packages/sangfor-product-adapters/src/index.js';

type JsonRpcRequest = { jsonrpc: '2.0'; id?: string | number; method: string; params?: any };

type ToolHandler = (args: any) => unknown | Promise<unknown>;

const plans = new Map<string, any>();
const tools: Record<string, { description: string; inputSchema: any; handler: ToolHandler }> = {
  'sangfor.products': {
    description: 'List supported Sangfor products in current priority order.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => ({ products: PRODUCTS })
  },
  'sangfor.discover_product_console': {
    description: 'Discover product console strategy, login/API likelihood, menu routes and product capabilities for HCI/SCP, IAG, Endpoint Secure or NDR.',
    inputSchema: { type: 'object', properties: { product: { type: 'string' }, targetUrl: { type: 'string' }, version: { type: 'string' }, environment: { type: 'string' }, preferApi: { type: 'boolean' } } },
    handler: discoverProductConsole
  },
  'sangfor.collect_product_config': {
    description: 'Collect or plan read-only collection of current product configuration. Uses API-first for HCI/SCP, WebUI-first for IAG/Endpoint Secure, hybrid for NDR.',
    inputSchema: { type: 'object', properties: { product: { type: 'string' }, targetUrl: { type: 'string' }, version: { type: 'string' }, environment: { type: 'string' }, preferApi: { type: 'boolean' } } },
    handler: collectProductConfig
  },
  'sangfor.analyze_customer_requirements': {
    description: 'Break customer requirement strings into product-specific configuration tasks with menu paths, API candidates, risk and approval gates.',
    inputSchema: { type: 'object', properties: { product: { type: 'string' }, targetUrl: { type: 'string' }, version: { type: 'string' }, environment: { type: 'string' }, requirements: { type: 'array', items: { type: 'string' } }, currentConfig: { type: 'object' } }, required: ['requirements'] },
    handler: analyzeCustomerRequirements
  },
  'sangfor.generate_product_change_plan': {
    description: 'Generate product change plan with menu path, API endpoint candidates, current/target planning context, impact/risk, rollback and validation.',
    inputSchema: { type: 'object', properties: { product: { type: 'string' }, targetUrl: { type: 'string' }, version: { type: 'string' }, environment: { type: 'string' }, requirements: { type: 'array', items: { type: 'string' } }, currentConfig: { type: 'object' } }, required: ['requirements'] },
    handler: generateProductChangePlan
  },
  'sangfor.import_excel_requirement_list': {
    description: 'Import an ITAC-style Excel checklist and normalize rows into configuration requirements, evidence needs, target controls, gaps and priority.',
    inputSchema: { type: 'object', properties: { filePath: { type: 'string' }, sheetName: { type: 'string' }, prioritizeOnly: { type: 'boolean' } }, required: ['filePath'] },
    handler: importExcelRequirementList
  },
  'sangfor.map_requirements_to_products': {
    description: 'Map normalized Excel checklist rows to HCI/SCP, IAG, Endpoint Secure, NDR, or external/manual handling.',
    inputSchema: { type: 'object', properties: { rows: { type: 'array', items: { type: 'object' } } }, required: ['rows'] },
    handler: mapRequirementsToProducts
  },
  'sangfor.generate_excel_based_change_plan': {
    description: 'Generate a multi-product dry-run change plan from an ITAC-style Excel checklist. Actual mutation remains blocked.',
    inputSchema: { type: 'object', properties: { filePath: { type: 'string' }, rows: { type: 'array', items: { type: 'object' } }, sheetName: { type: 'string' }, prioritizeOnly: { type: 'boolean' } } },
    handler: generateExcelBasedChangePlan
  },
  'sangfor.dry_run_product_change': {
    description: 'Dry-run a product change plan. WebUI route preview stops before Save/Apply/Delete; API changes produce request previews only.',
    inputSchema: { type: 'object', properties: { plan: { type: 'object' }, targetUrl: { type: 'string' }, sessionId: { type: 'string' } }, required: ['plan'] },
    handler: dryRunProductChange
  },
  'sangfor.apply_approved_product_change': {
    description: 'Apply only an approved product change. Requires approval payload and SANGFOR_ALLOW_REAL_EXECUTION; production also requires SANGFOR_ALLOW_PRODUCTION_EXECUTION.',
    inputSchema: { type: 'object', properties: { plan: { type: 'object' }, approval: { type: 'object' }, environment: { type: 'string' }, sessionId: { type: 'string' } }, required: ['plan'] },
    handler: applyApprovedProductChange
  },
  'sangfor.verify_product_change': {
    description: 'Verify a product change with read-only API/WebUI re-collection checklist and evidence expectations.',
    inputSchema: { type: 'object', properties: { plan: { type: 'object' }, observed: { type: 'object' } }, required: ['plan'] },
    handler: verifyProductChange
  },
  'sangfor.search_manuals': {
    description: 'Search Sangfor manual/guide chunks by product, version and query.',
    inputSchema: { type: 'object', properties: { product: { type: 'string' }, version: { type: 'string' }, query: { type: 'string' }, limit: { type: 'number' } }, required: ['product'] },
    handler: searchManuals
  },
  'sangfor.get_manual_section': {
    description: 'Get one manual section by chunk id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    handler: ({ id }) => getManualSection(id) ?? { error: `Manual section not found: ${id}` }
  },
  'sangfor.search_wiki': {
    description: 'Search internal wiki chunks by product, version and query.',
    inputSchema: { type: 'object', properties: { product: { type: 'string' }, version: { type: 'string' }, query: { type: 'string' }, limit: { type: 'number' } }, required: ['product'] },
    handler: searchWiki
  },

  'sangfor.ingest_document': {
    description: 'Parse PDF/HTML/Markdown/TXT document, chunk it, create local vector index, and store searchable RAG chunks.',
    inputSchema: { type: 'object', properties: { filePath: { type: 'string' }, product: { type: 'string' }, version: { type: 'string' }, sourceType: { type: 'string' }, trustLevel: { type: 'string' }, title: { type: 'string' }, indexPath: { type: 'string' } }, required: ['filePath', 'product'] },
    handler: ingestDocument
  },
  'sangfor.rag_search': {
    description: 'Search real ingested local RAG index by product/version/query.',
    inputSchema: { type: 'object', properties: { product: { type: 'string' }, version: { type: 'string' }, query: { type: 'string' }, limit: { type: 'number' }, indexPath: { type: 'string' } }, required: ['query'] },
    handler: (args) => ragSearch(args)
  },
  'sangfor.rag_index_summary': {
    description: 'Return summary of the real local RAG index.',
    inputSchema: { type: 'object', properties: { indexPath: { type: 'string' } } },
    handler: ({ indexPath }) => exportRagIndexSummary(indexPath)
  },
  'sangfor.store_health': {
    description: 'Check PostgreSQL persistence (Prisma) when DATABASE_URL is configured.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => storeHealthCheck()
  },
  'sangfor.learn_sources': {
    description: 'Collect Sangfor KB catalog, Community threads, ingest demo docs, update local RAG index and fine-tune JSONL. Uses .env / SANGFOR_ONE_ACCESS_TOKEN when present.',
    inputSchema: {
      type: 'object',
      properties: {
        communityMaxThreadsPerForum: { type: 'number', description: 'Per forum; omit for all threads on listing page' },
        knowledgeMaxArticles: { type: 'number', description: 'KB catalog cap; omit for full catalog' },
        includeDemoDocs: { type: 'boolean' },
        ragIndexPath: { type: 'string' },
        rawDir: { type: 'string' }
      }
    },
    handler: async (args) => {
      loadEnvFile('.env');
      return runLearnSourcesPipeline({
        communityMaxThreadsPerForum: args.communityMaxThreadsPerForum,
        knowledgeMaxArticles: args.knowledgeMaxArticles,
        includeDemoDocs: args.includeDemoDocs,
        ragIndexPath: args.ragIndexPath,
        rawDir: args.rawDir,
        ingestDocumentFn: ingestDocument,
        exportRagSummaryFn: exportRagIndexSummary,
        createFineTuneDatasetFn: createFineTuneDataset,
        validateFineTuneDatasetFn: validateFineTuneDataset
      });
    }
  },
  'sangfor.analyze_project': {
    description: 'Analyze customer project input and return product, project type, risk, missing inputs and knowledge queries.',
    inputSchema: { type: 'object', properties: { customerName: { type: 'string' }, product: { type: 'string' }, version: { type: 'string' }, projectType: { type: 'string' }, environment: { type: 'object' }, requirements: { type: 'array', items: { type: 'string' } } }, required: ['customerName'] },
    handler: analyzeProject
  },
  'sangfor.generate_config_plan': {
    description: 'Generate a configuration plan with precheck, steps, rollback, validation and approval gates.',
    inputSchema: { type: 'object', properties: { customerName: { type: 'string' }, product: { type: 'string' }, version: { type: 'string' }, projectType: { type: 'string' }, environment: { type: 'object' }, requirements: { type: 'array', items: { type: 'string' } } }, required: ['customerName', 'product'] },
    handler: async (args) => {
      const plan = await generateConfigPlanAsync(args);
      plans.set(plan.id, plan);
      const dbId = await persistConfigPlan(plan).catch(() => null);
      return dbId ? { ...plan, persistedId: dbId } : plan;
    }
  },
  'sangfor.validate_config_plan': {
    description: 'Validate that a generated plan has precheck, steps, rollback, validation and references.',
    inputSchema: { type: 'object', properties: { planId: { type: 'string' }, plan: { type: 'object' } } },
    handler: ({ planId, plan }) => validateConfigPlan(plan ?? plans.get(planId))
  },
  'sangfor.request_approval': {
    description: 'Classify text/action risk and return approval decision.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    handler: ({ text }) => requiresApprovalForText(text)
  },
  'sangfor.start_operator_session': {
    description: 'Start a mock/lab/poc/customer operator session. MVP defaults to mock.',
    inputSchema: { type: 'object', properties: { product: { type: 'string' }, mode: { type: 'string' }, targetUrl: { type: 'string' }, browser: { type: 'object', properties: { cdpEndpoint: { type: 'string' }, useLocalBrowser: { type: 'boolean' } } } }, required: ['product'] },
    handler: startOperatorSession
  },
  'sangfor.read_console_state': {
    description: 'Read current mock console state for a session.',
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] },
    handler: ({ sessionId }) => readConsoleState(sessionId)
  },
  'sangfor.execute_console_action': {
    description: 'Execute or dry-run a console action. MVP blocks high-risk non-dry-run operations.',
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, action: { type: 'object' } }, required: ['sessionId', 'action'] },
    handler: ({ sessionId, action }) => executeConsoleAction(sessionId, action)
  },

  'sangfor.read_live_console_state': {
    description: 'Read live Sangfor Web Console state using Playwright. Requires targetUrl session. Read-only snapshot.',
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] },
    handler: readLiveConsoleState
  },
  'sangfor.execute_console_action_live': {
    description: 'Execute a real Playwright console action. Requires SANGFOR_ALLOW_REAL_EXECUTION and approval fields for non-dry-run.',
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, action: { type: 'object' }, approval: { type: 'object' } }, required: ['sessionId', 'action'] },
    handler: executeLiveConsoleAction
  },
  'sangfor.kill_session': {
    description: 'Cancel an operator session.',
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] },
    handler: ({ sessionId }) => killSession(sessionId)
  },
  'sangfor.verify_result': {
    description: 'Verify plan/result. MVP returns manual validation checklist.',
    inputSchema: { type: 'object', properties: { planId: { type: 'string' }, plan: { type: 'object' }, observed: { type: 'object' } } },
    handler: ({ planId, plan, observed }) => verifyResult({ plan: plan ?? plans.get(planId), observed })
  },
  'sangfor.generate_evidence_report': {
    description: 'Generate Markdown evidence report for a plan.',
    inputSchema: { type: 'object', properties: { planId: { type: 'string' }, plan: { type: 'object' }, verification: { type: 'object' }, format: { type: 'string' } } },
    handler: ({ planId, plan, verification, format }) => generateEvidenceReport({ plan: plan ?? plans.get(planId), verification, format })
  },
  'sangfor.submit_feedback': {
    description: 'Submit feedback linked to a product/plan/session.',
    inputSchema: { type: 'object', properties: { product: { type: 'string' }, feedbackType: { type: 'string' }, severity: { type: 'string' }, feedbackText: { type: 'string' }, sourceRole: { type: 'string' } }, required: ['product', 'feedbackType', 'severity', 'feedbackText', 'sourceRole'] },
    handler: async (args) => {
      const event = submitFeedback(args);
      const dbId = await persistFeedbackEvent(event).catch(() => null);
      return dbId ? { ...event, persistedId: dbId } : event;
    }
  },
  'sangfor.extract_lesson': {
    description: 'Extract a lesson learned from feedback.',
    inputSchema: { type: 'object', properties: { feedbackId: { type: 'string' } }, required: ['feedbackId'] },
    handler: ({ feedbackId }) => extractLesson(feedbackId)
  },
  'sangfor.propose_wiki_update': {
    description: 'Create a wiki update proposal from a lesson. Does not directly modify wiki.',
    inputSchema: { type: 'object', properties: { lessonTitle: { type: 'string' }, lessonBody: { type: 'string' }, targetPage: { type: 'string' } }, required: ['lessonTitle', 'lessonBody'] },
    handler: proposeWikiUpdate
  },
  'sangfor.approve_wiki_update': {
    description: 'Approve or reject a wiki update proposal.',
    inputSchema: { type: 'object', properties: { proposalId: { type: 'string' }, decision: { type: 'string' } }, required: ['proposalId', 'decision'] },
    handler: ({ proposalId, decision }) => approveWikiUpdate(proposalId, decision)
  },
  'sangfor.apply_wiki_update': {
    description: 'Apply an approved wiki update proposal. Blocks pending proposals.',
    inputSchema: { type: 'object', properties: { proposalId: { type: 'string' } }, required: ['proposalId'] },
    handler: ({ proposalId }) => applyWikiUpdate(proposalId)
  },

  'sangfor.apply_obsidian_wiki_update': {
    description: 'Apply an approved wiki update proposal to an Obsidian vault path.',
    inputSchema: { type: 'object', properties: { proposalId: { type: 'string' }, vaultPath: { type: 'string' } }, required: ['proposalId', 'vaultPath'] },
    handler: applyObsidianWikiUpdate
  },
  'sangfor.apply_github_wiki_update': {
    description: 'Apply an approved wiki update proposal to a GitHub Wiki git repository. Uses git CLI and provided repoUrl/localPath.',
    inputSchema: { type: 'object', properties: { proposalId: { type: 'string' }, repoUrl: { type: 'string' }, localPath: { type: 'string' } }, required: ['proposalId', 'repoUrl'] },
    handler: applyGitHubWikiUpdate
  },
  'sangfor.create_eval_case_from_feedback': {
    description: 'Create planner regression eval case from feedback.',
    inputSchema: { type: 'object', properties: { product: { type: 'string' }, name: { type: 'string' }, requiredText: { type: 'string' } }, required: ['product', 'name', 'requiredText'] },
    handler: createEvalCaseFromFeedback
  },

  'sangfor.create_finetune_dataset': {
    description: 'Create JSONL fine-tuning dataset from reviewed Sangfor examples. Blocks secrets during validation step.',
    inputSchema: { type: 'object', properties: { product: { type: 'string' }, taskType: { type: 'string' }, examples: { type: 'array' }, outputPath: { type: 'string' } }, required: ['product', 'taskType', 'examples'] },
    handler: createFineTuneDataset
  },
  'sangfor.validate_finetune_dataset': {
    description: 'Validate JSONL fine-tuning dataset for structure and obvious sensitive data.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    handler: ({ path }) => validateFineTuneDataset(path)
  },
  'sangfor.create_finetune_job_spec': {
    description: 'Create a reviewed fine-tuning job manifest. Does not submit automatically.',
    inputSchema: { type: 'object', properties: { provider: { type: 'string' }, baseModel: { type: 'string' }, datasetPath: { type: 'string' }, validationDatasetPath: { type: 'string' }, product: { type: 'string' }, taskType: { type: 'string' } }, required: ['datasetPath', 'product', 'taskType'] },
    handler: createFineTuneJobSpec
  },
  'sangfor.run_planner_eval': {
    description: 'Run built-in planner evals against a generated config plan.',
    inputSchema: { type: 'object', properties: { planId: { type: 'string' }, plan: { type: 'object' } } },
    handler: ({ planId, plan }) => runPlannerEval(plan ?? plans.get(planId))
  }
};

function listTools() {
  return Object.entries(tools).map(([name, tool]) => ({
    name,
    description: tool.description,
    inputSchema: tool.inputSchema
  }));
}

async function handle(req: JsonRpcRequest) {
  try {
    if (req.method === 'initialize') {
      return { jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'sangfor-engineer-mcp', version: '0.1.0' }, capabilities: { tools: { listChanged: false } } } };
    }
    if (req.method === 'tools/list') {
      return { jsonrpc: '2.0', id: req.id, result: { tools: listTools() } };
    }
    if (req.method === 'tools/call') {
      const name = req.params?.name;
      const args = req.params?.arguments ?? {};
      const tool = tools[name];
      if (!tool) throw new Error(`Unknown tool: ${name}`);
      const result = await tool.handler(args);
      return { jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: false } };
    }
    return { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `Method not found: ${req.method}` } };
  } catch (error) {
    return { jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: String(error instanceof Error ? error.message : error) }], isError: true } };
  }
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line) as JsonRpcRequest;
  const res = await handle(req);
  process.stdout.write(`${JSON.stringify(res)}\n`);
});

process.stderr.write('sangfor-engineer-mcp stdio server started\n');
