import readline from 'node:readline';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
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
  verifyProductChange,
  buildSettingGuideDocx,
  buildOperationsGuideDocx,
  buildComprehensiveSettingGuideDocx,
  buildComprehensiveOperationsGuideDocx,
} from '../../../packages/sangfor-product-adapters/src/index.js';
import { buildSettingGuidePptx, buildOperationsGuidePptx } from '../../../packages/sangfor-pptx/src/index.js';
import { captureProductScreenshots } from '../../../packages/sangfor-screenshot/src/index.js';
import { loadSpec, evaluateSpec, renderAdvisoryReport, renderAdvisoryReportDocx, listSpecCoverage, type IntendedSpec } from '../../../packages/sangfor-spec/src/index.js';
import { getCapabilitySafety, listCapabilitySafety } from '../../../packages/sangfor-safety/src/index.js';
import { loadWorkAtoms, computeReplacementCoverage } from '../../../packages/sangfor-competency/src/index.js';
import { suggestRca } from '../../../packages/sangfor-rca/src/index.js';
import { recommendSizing, type SizingInput } from '../../../packages/sangfor-sizing/src/index.js';
import { createPmStore } from '../../../packages/sangfor-pm/src/index.js';
import { checkVersionRequirement, loadVersionRequirements } from '../../../packages/sangfor-version/src/index.js';
import { generateIntegrationGuide, listIntegrationTypes } from '../../../packages/sangfor-integration/src/index.js';

const pmStore = createPmStore(); // process-lifetime PM state for the MCP session

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
  'sangfor.generate_setting_guide_docx': {
    description: 'Generate a Word (.docx) customer setting guide from an ITAC-style Excel checklist. Produces a formatted document with product tables, manual evidence section, dry-run procedure, and customer action items.',
    inputSchema: { type: 'object', properties: { filePath: { type: 'string', description: 'Path to the ITAC Excel (.xlsx) file' }, outputPath: { type: 'string', description: 'Optional output path for the .docx file' } }, required: ['filePath'] },
    handler: (args: { filePath: string; outputPath?: string }) => buildSettingGuideDocx({ filePath: args.filePath, outputPath: args.outputPath })
  },
  'sangfor.generate_setting_guide_pptx': {
    description: 'Generate a PowerPoint (.pptx) customer setting guide from an ITAC-style Excel checklist. Produces a formatted presentation with product-specific slides, tables, charts, and dry-run procedures.',
    inputSchema: { type: 'object', properties: { filePath: { type: 'string', description: 'Path to the ITAC Excel (.xlsx) file' }, outputPath: { type: 'string', description: 'Optional output path for the .pptx file' }, screenshotDir: { type: 'string', description: 'Optional directory containing product screenshots' } }, required: ['filePath'] },
    handler: (args: { filePath: string; outputPath?: string; screenshotDir?: string }) => buildSettingGuidePptx({ filePath: args.filePath, outputPath: args.outputPath, screenshotDir: args.screenshotDir })
  },
  'sangfor.generate_operations_guide_pptx': {
    description: 'Generate a PowerPoint (.pptx) operations guide for Sangfor products covering daily monitoring, weekly/monthly procedures, incident response, and security policies.',
    inputSchema: { type: 'object', properties: { outputPath: { type: 'string', description: 'Optional output path for the .pptx file' } } },
    handler: (args: { outputPath?: string }) => buildOperationsGuidePptx({ outputPath: args.outputPath })
  },
  'sangfor.generate_operations_guide_docx': {
    description: 'Generate a Word (.docx) operations guide for Sangfor products covering daily monitoring, weekly/monthly inspection, incident response, and security policy management.',
    inputSchema: { type: 'object', properties: { outputPath: { type: 'string', description: 'Optional output path for the .docx file' } } },
    handler: (args: { outputPath?: string }) => buildOperationsGuideDocx({ outputPath: args.outputPath })
  },
  'sangfor.generate_comprehensive_setting_guide_docx': {
    description: 'Generate a comprehensive Word (.docx) customer setting guide with detailed setup procedures, product-specific configuration, operational steps, security policies, backup/recovery, and troubleshooting. Much more detailed than the basic setting guide.',
    inputSchema: { type: 'object', properties: { filePath: { type: 'string', description: 'Path to the ITAC Excel (.xlsx) file' }, outputPath: { type: 'string', description: 'Optional output path for the .docx file' }, screenshotDir: { type: 'string', description: 'Optional directory containing product screenshots (outputs/final_images)' } }, required: ['filePath'] },
    handler: (args: { filePath: string; outputPath?: string; screenshotDir?: string }) => buildComprehensiveSettingGuideDocx({ filePath: args.filePath, outputPath: args.outputPath, screenshotDir: args.screenshotDir })
  },
  'sangfor.generate_comprehensive_operations_guide_docx': {
    description: 'Generate a comprehensive Word (.docx) operations guide covering detailed daily/weekly/monthly procedures, incident response, backup/recovery, security policy management, performance monitoring, and troubleshooting FAQ.',
    inputSchema: { type: 'object', properties: { outputPath: { type: 'string', description: 'Optional output path for the .docx file' }, screenshotDir: { type: 'string', description: 'Optional directory containing product screenshots (outputs/final_images)' } } },
    handler: (args: { outputPath?: string; screenshotDir?: string }) => buildComprehensiveOperationsGuideDocx({ outputPath: args.outputPath, screenshotDir: args.screenshotDir })
  },
  'sangfor.capture_screenshots': {
    description: 'Capture screenshots from Sangfor product consoles (EPP, IAG, CC) via Chrome CDP. Connects to the product console, logs in, navigates menus, and saves screenshots.',
    inputSchema: { type: 'object', properties: { product: { type: 'string', enum: ['EPP', 'IAG', 'CC'], description: 'Product to capture screenshots from' }, targetUrl: { type: 'string', description: 'Override target URL' }, username: { type: 'string', description: 'Login username' }, password: { type: 'string', description: 'Login password' }, outputDir: { type: 'string', description: 'Output directory for screenshots' }, headless: { type: 'boolean', description: 'Run Chrome in headless mode' }, dryRun: { type: 'boolean', description: 'Dry-run mode: skip Chrome and just list planned screenshots' } }, required: ['product'] },
    handler: (args: { product: 'EPP' | 'IAG' | 'CC'; targetUrl?: string; username?: string; password?: string; outputDir?: string; headless?: boolean; dryRun?: boolean }) => captureProductScreenshots(args)
  },
  'sangfor.generate_all_guides': {
    description: 'Generate complete guide set: setting guide (docx + pptx), operations guide (docx + pptx), and optionally capture screenshots. Uses the ITAC Excel as input.',
    inputSchema: { type: 'object', properties: { filePath: { type: 'string', description: 'Path to the ITAC Excel (.xlsx) file' }, outputDir: { type: 'string', description: 'Output directory for all guides' }, screenshotDir: { type: 'string', description: 'Directory containing product screenshots (default: outputs/final_images)' }, captureScreenshots: { type: 'boolean', description: 'Also capture product console screenshots' }, screenshotProducts: { type: 'array', items: { type: 'string' }, description: 'Products to capture screenshots for (EPP, IAG, CC)' } }, required: ['filePath'] },
    handler: async (args: { filePath: string; outputDir?: string; screenshotDir?: string; captureScreenshots?: boolean; screenshotProducts?: string[] }) => {
      const outDir = args.outputDir ?? join(process.cwd(), 'outputs');
      const screenshotDir = args.screenshotDir ?? join(process.cwd(), 'outputs', 'final_images');
      mkdirSync(outDir, { recursive: true });
      const results: Record<string, unknown> = {};
      try {
        results.settingDocx = buildSettingGuideDocx({ filePath: args.filePath, outputPath: join(outDir, 'Sangfor_설정가이드_MCP.docx') });
      } catch (err) { results.settingDocxError = String(err); }
      try {
        results.settingPptx = await buildSettingGuidePptx({ filePath: args.filePath, outputPath: join(outDir, 'Sangfor_설정가이드_MCP.pptx') });
      } catch (err) { results.settingPptxError = String(err); }
      try {
        results.operationsPptx = await buildOperationsGuidePptx({ outputPath: join(outDir, 'Sangfor_운영가이드_MCP.pptx') });
      } catch (err) { results.operationsPptxError = String(err); }
      try {
        results.operationsDocx = buildOperationsGuideDocx({ outputPath: join(outDir, 'Sangfor_운영가이드_MCP.docx') });
      } catch (err) { results.operationsDocxError = String(err); }
      try {
        results.comprehensiveSettingDocx = buildComprehensiveSettingGuideDocx({ filePath: args.filePath, outputPath: join(outDir, 'Sangfor_설정가이드_v6_종합메뉴얼.docx'), screenshotDir });
      } catch (err) { results.comprehensiveSettingDocxError = String(err); }
      try {
        results.comprehensiveOpsDocx = buildComprehensiveOperationsGuideDocx({ outputPath: join(outDir, 'Sangfor_운영가이드_v6_종합메뉴얼.docx'), screenshotDir });
      } catch (err) { results.comprehensiveOpsDocxError = String(err); }
      if (args.captureScreenshots) {
        const products = args.screenshotProducts ?? ['EPP', 'IAG', 'CC'];
        results.screenshots = {};
        for (const product of products) {
          try {
            (results.screenshots as Record<string, unknown>)[product] = await captureProductScreenshots({
              product: product as 'EPP' | 'IAG' | 'CC',
              outputDir: join(outDir, 'screenshots', product),
            });
          } catch (err) {
            (results.screenshots as Record<string, unknown>)[product] = { error: String(err) };
          }
        }
      }
      return results;
    }
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
  },
  'sangfor.evaluate_config': {
    description: 'Advisory (read-only) config check: compare an observed product config against an IntendedSpec (from manuals) and split findings into misconfiguration / missing / indeterminate / ok. Never mutates a device. INDETERMINATE never counts as pass; MUST items without a source citation stay indeterminate. Returns the evaluation and a Korean advisory report; pass docxPath to also write a .docx.',
    inputSchema: { type: 'object', properties: { product: { type: 'string' }, version: { type: 'string' }, observed: { type: 'object', description: 'observed config key→value map (from screenshot/backup/human)' }, spec: { type: 'object', description: 'optional inline IntendedSpec; if omitted, loaded by product+version' }, docxPath: { type: 'string', description: 'optional path to also write the report as a .docx' } }, required: ['observed'] },
    handler: (args: { product?: string; version?: string; observed: Record<string, unknown>; spec?: IntendedSpec; docxPath?: string }) => {
      const spec = args.spec ?? (args.product && args.version ? loadSpec(args.product, args.version) : null);
      if (!spec) return { error: `No IntendedSpec found for ${args.product ?? '?'} ${args.version ?? '?'}. Provide an inline spec or seed data/specs/. Coverage: ${JSON.stringify(listSpecCoverage())}` };
      const result = evaluateSpec(spec, args.observed ?? {});
      const report = renderAdvisoryReport(spec, result);
      const docx = args.docxPath ? renderAdvisoryReportDocx(spec, result, args.docxPath) : undefined;
      return { result, report, ...(docx ? { docx } : {}) };
    }
  },
  'sangfor.list_spec_coverage': {
    description: 'List which product/version IntendedSpecs exist (advisory coverage) so callers know what config checks are available.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => ({ coverage: listSpecCoverage() })
  },
  'sangfor.capability_safety': {
    description: 'Report capability safety_class and maturity from physically separated safety/competency files. Default is human_only; autoAllowed is true only for explicit auto_allowed entries, and fieldVerifiedAutoAllowed additionally requires maturity=field_verified.',
    inputSchema: { type: 'object', properties: { product: { type: 'string' }, capabilityId: { type: 'string' } } },
    handler: (args: { product?: string; capabilityId?: string }) => args.product && args.capabilityId
      ? getCapabilitySafety(args.product, args.capabilityId)
      : { capabilities: listCapabilitySafety() }
  },
  'sangfor.field_engineer_coverage': {
    description: 'Honest "field-engineer replacement rate" from the WorkAtom taxonomy: counts ONLY automatable AND field_verified atoms. Human-only atoms never count. Returns per-phase and per-product breakdown.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => ({ coverage: computeReplacementCoverage(loadWorkAtoms()), atoms: loadWorkAtoms() })
  },
  'sangfor.suggest_rca': {
    description: 'Suggest ranked root-cause candidates + concrete check steps for a symptom (read-only advisory). Grounded in product manuals; returns empty (no fabrication) for unrelated symptoms.',
    inputSchema: { type: 'object', properties: { symptom: { type: 'string' }, product: { type: 'string' } }, required: ['symptom'] },
    handler: (args: { symptom: string; product?: string }) => suggestRca(args.symptom, args.product)
  },
  'sangfor.recommend_sizing': {
    description: 'Advisory sizing tier (small/medium/large/xlarge) from the primary scale driver (IAG=users, EPP=endpoints, HCI=vmCount, CC=eps, NGFW=Mbps). Never invents an exact model/BOM — defers to official Sizing Guide + SE validation.',
    inputSchema: { type: 'object', properties: { product: { type: 'string' }, concurrentUsers: { type: 'number' }, endpoints: { type: 'number' }, vmCount: { type: 'number' }, eventsPerSecond: { type: 'number' }, throughputMbps: { type: 'number' } }, required: ['product'] },
    handler: (args: { product: string } & SizingInput) => recommendSizing(args.product, args)
  },
  'sangfor.pm_create_engagement': {
    description: 'PM: create an engagement (customer project).',
    inputSchema: { type: 'object', properties: { customer: { type: 'string' }, product: { type: 'string' } }, required: ['customer', 'product'] },
    handler: (args: { customer: string; product: string }) => pmStore.createEngagement(args)
  },
  'sangfor.pm_add_work_item': {
    description: 'PM: add a work item to an engagement.',
    inputSchema: { type: 'object', properties: { engagementId: { type: 'string' }, title: { type: 'string' }, deviceId: { type: 'string' }, assignee: { type: 'string' } }, required: ['engagementId', 'title'] },
    handler: (args: { engagementId: string; title: string; deviceId?: string; assignee?: string }) => pmStore.addWorkItem(args.engagementId, args)
  },
  'sangfor.pm_status': {
    description: 'PM: status rollup for an engagement + current device occupancy (who holds which device).',
    inputSchema: { type: 'object', properties: { engagementId: { type: 'string' } }, required: ['engagementId'] },
    handler: (args: { engagementId: string }) => ({ rollup: pmStore.statusRollup(args.engagementId), deviceOccupancy: pmStore.deviceOccupancy(), chainOk: pmStore.verifyEventChain(args.engagementId) })
  },
  'sangfor.integration_guide': {
    description: 'Standard integration guide (AD/LDAP, RADIUS, SIEM/syslog): cited prerequisites → steps → validation → pitfalls for the human to follow. Unknown integration type returns an error (no fabrication). No type → list supported types.',
    inputSchema: { type: 'object', properties: { type: { type: 'string', description: 'LDAP/AD, RADIUS, or SIEM/syslog' }, product: { type: 'string' } } },
    handler: (args: { type?: string; product?: string }) => {
      if (!args.type) return { supported: listIntegrationTypes() };
      const g = generateIntegrationGuide(args.type, args.product);
      return g ?? { error: `Unknown integration type "${args.type}". Supported: ${listIntegrationTypes().join(', ')}` };
    }
  },
  'sangfor.check_version': {
    description: 'Upgrade advisory: check a device version against the collected Version Requirements (min/recommended) and return meetsMin/atRecommended + cited advice. Returns null-style error for unknown devices (no fabricated compatibility claim). No args → list known requirements.',
    inputSchema: { type: 'object', properties: { device: { type: 'string' }, currentVersion: { type: 'string' } } },
    handler: (args: { device?: string; currentVersion?: string }) => {
      if (!args.device || !args.currentVersion) return { requirements: loadVersionRequirements() };
      const r = checkVersionRequirement(args.device, args.currentVersion);
      return r ?? { error: `No version requirement on file for device "${args.device}". Known: ${loadVersionRequirements().map((x) => x.device).join(', ')}` };
    }
  },
  'sangfor.pm_acquire_device': {
    description: 'PM safety: acquire an exclusive device lock for an engagement before any device work. Blocks if another engagement holds it (prevents cross-engagement changes on a shared lab device).',
    inputSchema: { type: 'object', properties: { deviceId: { type: 'string' }, engagementId: { type: 'string' }, holder: { type: 'string' } }, required: ['deviceId', 'engagementId', 'holder'] },
    handler: (args: { deviceId: string; engagementId: string; holder: string }) => pmStore.acquireDevice(args.deviceId, args.engagementId, args.holder)
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
  let req: JsonRpcRequest;
  try {
    req = JSON.parse(line) as JsonRpcRequest;
  } catch {
    // Malformed JSON must not crash the stdio server — emit a JSON-RPC parse error.
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
    return;
  }
  try {
    const res = await handle(req);
    process.stdout.write(`${JSON.stringify(res)}\n`);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: req?.id ?? null, error: { code: -32603, message: String(err instanceof Error ? err.message : err) } })}\n`);
  }
});

process.on('unhandledRejection', (e) => process.stderr.write(`unhandledRejection: ${String(e)}\n`));
process.on('uncaughtException', (e) => process.stderr.write(`uncaughtException: ${String(e)}\n`));

process.stderr.write('sangfor-engineer-mcp stdio server started\n');
