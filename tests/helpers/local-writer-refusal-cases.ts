import { join } from 'node:path';
import { AgentTaskStore, AnalysisStore, PlaybookStore } from '../../apps/control-tower/src/playbook-store.js';
import { Registry } from '../../apps/control-tower/src/registry.js';
import { FileSingleUseNonceStore } from '../../packages/sangfor-approval/src/index.js';
import { AuditLedger } from '../../packages/sangfor-hci-client/src/index.js';
import { appendEngineerReport } from '../../packages/sangfor-engineer-report/src/index.js';
import { RunStore } from '../../packages/sangfor-runs/src/index.js';
import { createEvalCaseFromFeedback } from '../../packages/sangfor-evals/src/index.js';
import { extractLesson, submitFeedback } from '../../packages/sangfor-feedback/src/index.js';
import {
  GitHubWikiGitAdapter,
  ObsidianVaultAdapter,
  applyWikiUpdate,
  applyWikiUpdateWithAdapter,
  approveWikiUpdate,
  proposeWikiUpdate,
  upsertKnowledgeCard,
  type WikiAdapter,
} from '../../packages/sangfor-wiki/src/index.js';
import { StrategyStoreManager } from '../../packages/sangfor-learning-strategy/src/store.js';
import { recordSnapshot } from '../../packages/sangfor-chronicle/src/index.js';
import {
  FilePromotionLedger,
  evidenceIdSchema,
  sha256Schema,
} from '../../packages/sangfor-competency/src/index.js';
import { initializePromotionStore } from '../../packages/sangfor-competency/src/promotion-checkpoint.js';
import {
  explicitLocalPrimaryAuthority,
  resolveEngagementScopedData,
  type LocalWriteAuthority,
} from '../../packages/shared/src/index.js';

export type WriterRefusalCase = {
  readonly reference: string;
  readonly invoke: () => Promise<unknown>;
};

const engineResult = {
  specId: 'spec', ok: true, items: [],
  summary: { pass: 0, fail: 0, indeterminate: 0, misconfiguration: 0, missing: 0, contextDependent: 0 },
  coverage: { specifiedTotal: 0, observedTotal: 0, unspecifiedKeys: [], unobservedItems: [] },
};

export async function localWriterRefusalCases(
  root: string,
  authorityFor: (aggregate: string, sourceRoot: string) => LocalWriteAuthority,
): Promise<readonly WriterRefusalCase[]> {
  const registryRoot = join(root, 'registry');
  const runsRoot = join(root, 'runs');
  const auditRoot = join(root, 'audit');
  const evidenceRoot = join(root, 'evidence');
  const pmRoot = join(root, 'pm');
  const feedbackBase = join(root, 'feedback');
  const evalRoot = join(root, 'evals');
  const wikiRoot = join(root, 'wiki');
  const learningRoot = join(root, 'learning');
  const chronicleRoot = join(root, 'chronicle');
  const capabilityRoot = join(root, 'capability');
  process.env['SANGFOR_FEEDBACK_ROOT'] = feedbackBase;
  process.env['SANGFOR_EVALS_ROOT'] = evalRoot;
  process.env['SANGFOR_WIKI_ROOT'] = wikiRoot;
  process.env['SANGFOR_ENGAGEMENT_ID'] = 'writer-refusal';
  const feedbackRoot = resolveEngagementScopedData('data/feedback', 'SANGFOR_FEEDBACK_ROOT');

  const registryAuthority = authorityFor('registry_services', registryRoot);
  const runsAuthority = authorityFor('runs_steps', runsRoot);
  const feedbackAuthority = authorityFor('feedback_lessons', feedbackRoot);
  const wikiAuthority = authorityFor('wiki_proposals', wikiRoot);
  const learningAuthority = authorityFor('learning_strategy_lifecycle', learningRoot);
  const nonceRoot = join(root, 'nonce');
  const nonceAuthority = authorityFor('approvals_nonces', nonceRoot);
  const auditAuthority = authorityFor('audit', auditRoot);
  const evidenceAuthority = authorityFor('evidence', evidenceRoot);
  const pmAuthority = authorityFor('pm_tasks', pmRoot);
  const evalAuthority = authorityFor('evals', evalRoot);
  const chronicleAuthority = authorityFor('config_chronicle_state', chronicleRoot);
  const capabilityAuthority = authorityFor('capability_evidence_promotion', capabilityRoot);
  const promotionPath = join(capabilityRoot, 'promotion.jsonl');
  const ledgerSecret = 'ledger-secret-at-least-thirty-two-bytes';
  const checkpointSecret = 'checkpoint-secret-at-least-thirty-two';
  const localCapability = explicitLocalPrimaryAuthority({
    tenantId: 'writer-tenant', projectId: 'writer-project', actorId: 'writer-actor',
    aggregate: 'capability_evidence_promotion', sourceRoot: capabilityRoot,
  });
  await initializePromotionStore(promotionPath, checkpointSecret, localCapability);
  const promotionLedger = FilePromotionLedger.open(promotionPath, ledgerSecret, checkpointSecret, capabilityAuthority);
  const adapter: WikiAdapter = {
    readPage: async () => '',
    writePage: async () => ({ ok: true, path: 'unused', message: 'unused' }),
  };

  return [
    { reference: 'persist:apps/control-tower/src/playbook-store.ts#PlaybookStore', invoke: () => new PlaybookStore(registryRoot, registryAuthority).create({ name: 'p', goal: 'g', blocks: [{ id: 'b', type: 'tool', toolId: 't' }], authoredBy: 'a' }) },
    { reference: 'persist:apps/control-tower/src/registry.ts#Registry', invoke: () => new Registry(registryRoot, registryAuthority).seedVendors() },
    { reference: 'persist:apps/control-tower/src/playbook-store.ts#AnalysisStore', invoke: () => new AnalysisStore(runsRoot, runsAuthority).append({ schemaVersion: 1, id: 'a', playbookId: 'p', playbookRunId: 'r', summary: 's', improvements: [], proposals: [], authoredBy: 'a', createdAt: '2026-08-27T00:00:00.000Z' }) },
    { reference: 'persist:packages/sangfor-runs/src/run-store.ts#RunStore', invoke: () => new RunStore(runsRoot, runsAuthority).createRun({ toolId: 't', toolSafety: 'read_only', args: {}, initialStatus: 'succeeded' }) },
    { reference: 'persist:packages/sangfor-approval/src/index.ts#FileSingleUseNonceStore', invoke: () => new FileSingleUseNonceStore(join(nonceRoot, 'nonces.json'), nonceAuthority).consume('n', '2099-01-01T00:00:00.000Z') },
    { reference: 'persist:packages/sangfor-hci-client/src/audit-ledger.ts#AuditLedger', invoke: () => new AuditLedger({ dir: auditRoot, authority: auditAuthority }).append('r', 'request', {}) },
    { reference: 'persist:packages/sangfor-engineer-report/src/ledger.ts#appendEngineerReport', invoke: () => appendEngineerReport(evidenceRoot, { reportId: 'r', deviceId: 'd', snapshotHash: 'a'.repeat(64), engineResult, riskNote: '', recommendations: [], rollbackPlan: [], ragCitations: [], modelId: 'm', promptHash: 'b'.repeat(64), createdAt: '2026-08-27T00:00:00.000Z' }, evidenceAuthority) },
    { reference: 'persist:apps/control-tower/src/playbook-store.ts#AgentTaskStore', invoke: () => new AgentTaskStore(pmRoot, pmAuthority).create({ kind: 'assemble', payload: {} }) },
    { reference: 'persist:packages/sangfor-feedback/src/index.ts#submitFeedback', invoke: () => submitFeedback({ product: 'HCI', feedbackType: 'quality', severity: 'medium', feedbackText: 'x', sourceRole: 'engineer' }, feedbackAuthority) },
    { reference: 'persist:packages/sangfor-feedback/src/index.ts#extractLesson', invoke: () => extractLesson('missing', feedbackAuthority) },
    { reference: 'persist:packages/sangfor-evals/src/index.ts#createEvalCaseFromFeedback', invoke: () => createEvalCaseFromFeedback({ product: 'HCI', name: 'e', requiredText: 'x' }, evalAuthority) },
    { reference: 'persist:packages/sangfor-wiki/src/index.ts#ObsidianVaultAdapter', invoke: () => new ObsidianVaultAdapter(wikiRoot, wikiAuthority).writePage('p', 'x', 'm') },
    { reference: 'persist:packages/sangfor-wiki/src/index.ts#GitHubWikiGitAdapter', invoke: () => new GitHubWikiGitAdapter({ repoUrl: 'unused', localPath: wikiRoot }, wikiAuthority).writePage('p', 'x', 'm') },
    { reference: 'persist:packages/sangfor-wiki/src/index.ts#upsertKnowledgeCard', invoke: () => upsertKnowledgeCard({ type: 'procedure', product: 'HCI', title: 'c', prerequisites: [], steps: [], warnings: [], verification: [], rollback: [], citations: [{ sourceId: 's', spanText: 'x', quoteHash: 'a'.repeat(64) }], trustLevel: 'internal' }, wikiAuthority) },
    { reference: 'persist:packages/sangfor-wiki/src/index.ts#proposeWikiUpdate', invoke: () => proposeWikiUpdate({ lessonTitle: 'l', lessonBody: 'b' }, wikiAuthority) },
    { reference: 'persist:packages/sangfor-wiki/src/index.ts#approveWikiUpdate', invoke: () => approveWikiUpdate('missing', 'rejected', {}, wikiAuthority) },
    { reference: 'persist:packages/sangfor-wiki/src/index.ts#applyWikiUpdateWithAdapter', invoke: () => applyWikiUpdateWithAdapter('missing', adapter, wikiAuthority) },
    { reference: 'persist:packages/sangfor-wiki/src/index.ts#applyWikiUpdate', invoke: () => applyWikiUpdate('missing', wikiAuthority) },
    { reference: 'persist:packages/sangfor-learning-strategy/src/store.ts#StrategyStoreManager', invoke: () => { const manager = new StrategyStoreManager(join(learningRoot, 'strategy.json'), learningAuthority); return manager.commit(manager.createStrategy('s'), 0); } },
    { reference: 'persist:packages/sangfor-chronicle/src/store.ts#recordSnapshot', invoke: () => recordSnapshot({ deviceId: 'd', observed: {}, capturedAt: '2026-08-27T00:00:00.000Z', dir: chronicleRoot, authority: chronicleAuthority }) },
    { reference: 'persist:packages/sangfor-competency/src/promotion-checkpoint.ts#initializePromotionStore', invoke: () => initializePromotionStore(join(capabilityRoot, 'new.jsonl'), checkpointSecret, capabilityAuthority) },
    { reference: 'persist:packages/sangfor-competency/src/promotion-ledger.ts#FilePromotionLedger', invoke: () => promotionLedger.append({ version: 1, eventId: evidenceIdSchema.parse('event-1'), at: '2026-08-27T00:00:00.000Z', outcome: 'rejected', action: 'reject', target: { toolId: evidenceIdSchema.parse('tool'), productId: evidenceIdSchema.parse('HCI'), capabilityId: evidenceIdSchema.parse('capability'), workAtomIds: [] }, fromMaturity: 'tested_mock', toMaturity: 'tested_mock', decisionRef: sha256Schema.parse('a'.repeat(64)), manifestRef: sha256Schema.parse('b'.repeat(64)), nonceRef: null, refusalCode: evidenceIdSchema.parse('refused') }) },
  ];
}
