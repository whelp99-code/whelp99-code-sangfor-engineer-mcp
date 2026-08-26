import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Registry } from '../apps/control-tower/src/registry.js';
import { AgentTaskStore, AnalysisStore, PlaybookStore } from '../apps/control-tower/src/playbook-store.js';
import { RunStore } from '../packages/sangfor-runs/src/index.js';
import { AuditLedger } from '../packages/sangfor-hci-client/src/index.js';
import { appendEngineerReport } from '../packages/sangfor-engineer-report/src/index.js';
import { submitFeedback, extractLesson } from '../packages/sangfor-feedback/src/index.js';
import { createEvalCaseFromFeedback } from '../packages/sangfor-evals/src/index.js';
import { proposeWikiUpdate, upsertKnowledgeCard } from '../packages/sangfor-wiki/src/index.js';
import { StrategyStoreManager } from '../packages/sangfor-learning-strategy/src/store.js';
import { recordSnapshot } from '../packages/sangfor-chronicle/src/index.js';
import { FilePromotionLedger, evidenceIdSchema, sha256Schema } from '../packages/sangfor-competency/src/index.js';
import { FilesystemCutoverSourceAdapter } from '../packages/sangfor-authority/src/index.js';
import { filesBelow } from '../packages/sangfor-authority/src/cutover/source-files.js';
import { explicitLocalPrimaryAuthority, resolveEngagementScopedData } from '../packages/shared/src/index.js';
import type { AuthorityAggregate } from '../packages/sangfor-authority/src/migration-manifest.js';

const roots: string[] = []; const root = () => { const value = mkdtempSync(join(tmpdir(), 'native-cutover-')); roots.push(value); return value; };
afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }); });
const authority = (aggregate: AuthorityAggregate, sourceRoot: string) => explicitLocalPrimaryAuthority({
  tenantId: 'tenant-native', projectId: 'project-native', actorId: 'actor-native', aggregate, sourceRoot,
});
const files = (sourceRoot: string) => filesBelow(sourceRoot, () => true).map((file) => file.relativePath);
const adapter = (aggregate: AuthorityAggregate, sourceRoot: string, secrets: { ledger?: string; checkpoint?: string; audit?: string } = {}) =>
  new FilesystemCutoverSourceAdapter({
    aggregate, tenantId: 'tenant-native', sourceRoot, expectedFiles: files(sourceRoot),
    ...(secrets.audit ? { auditSecret: secrets.audit } : {}),
    ...(secrets.ledger ? { promotionLedgerSecret: secrets.ledger } : {}),
    ...(secrets.checkpoint ? { promotionCheckpointSecret: secrets.checkpoint } : {}),
  });

const engineResult = {
  specId: 'spec', ok: true, items: [],
  summary: { pass: 0, fail: 0, indeterminate: 0, misconfiguration: 0, missing: 0, contextDependent: 0 },
  coverage: { specifiedTotal: 0, observedTotal: 0, unspecifiedKeys: [], unobservedItems: [] },
};

describe('native local writers produce consumable cutover sources', () => {
  it('requires the matching configured secret for a keyed native audit ledger',async()=>{
    process.env.SANGFOR_ENGAGEMENT_ID='project-native';const auditRoot=root();const secret='native-audit-secret-at-least-32-bytes';await new AuditLedger({dir:auditRoot,authority:authority('audit',auditRoot),secret}).append('run','request',{ok:true});
    await expect(adapter('audit',auditRoot).capture('project-native')).rejects.toThrow('CUTOVER_AUDIT_SECRET_REQUIRED');
    await expect(adapter('audit',auditRoot,{audit:'wrong-audit-secret-at-least-32-bytes'}).capture('project-native')).rejects.toThrow();
    await expect(adapter('audit',auditRoot,{audit:secret}).capture('project-native')).resolves.toMatchObject({records:expect.any(Array)});
  });
  it('invokes all eleven aggregate writer surfaces, including vendor seed and capability checkpoint', async () => {
    process.env.SANGFOR_ENGAGEMENT_ID = 'project-native';
    const captures: Array<Promise<{ readonly records: readonly unknown[] }>> = [];
    const registryRoot = root(); const registryAuthority = authority('registry_services', registryRoot);
    const registry = new Registry(registryRoot, registryAuthority); await registry.seedVendors();
    await registry.createDevice({ name: 'device', product: 'FORTIOS', host: '127.0.0.1' });
    await new PlaybookStore(registryRoot, registryAuthority).create({ name: 'p', goal: 'g', blocks: [{ id: 'b1', type: 'tool', toolId: 'tool' }], authoredBy: 'actor' });
    captures.push(adapter('registry_services', registryRoot).capture('project-native'));

    const runsRoot = root(); const runsAuthority = authority('runs_steps', runsRoot);
    await new RunStore(runsRoot, runsAuthority).createRun({ toolId: 'tool', toolSafety: 'read_only', args: {}, initialStatus: 'succeeded' });
    await new AnalysisStore(runsRoot, runsAuthority).append({ schemaVersion: 1, id: 'analysis-1', playbookId: 'p', playbookRunId: 'pr', summary: 's', improvements: [], proposals: [], authoredBy: 'actor', createdAt: '2026-08-26T00:00:00.000Z' });
    captures.push(adapter('runs_steps', runsRoot).capture('project-native'));

    const auditRoot = root(); const auditAuthority = authority('audit', auditRoot); const auditSecret='native-audit-secret-at-least-32-bytes';
    await new AuditLedger({ dir: auditRoot, authority: auditAuthority, secret:auditSecret }).append('run-1', 'request', { ok: true });
    captures.push(adapter('audit', auditRoot,{audit:auditSecret}).capture('project-native'));

    const evidenceRoot = root(); const evidenceAuthority = authority('evidence', evidenceRoot);
    await appendEngineerReport(evidenceRoot, { reportId: 'report-1', deviceId: 'device-1', snapshotHash: 'a'.repeat(64), engineResult, riskNote: '', recommendations: [], rollbackPlan: [], ragCitations: [], modelId: 'model', promptHash: 'b'.repeat(64), createdAt: '2026-08-26T00:00:00.000Z' }, evidenceAuthority);
    captures.push(adapter('evidence', evidenceRoot).capture('project-native'));

    const pmRoot = root(); await new AgentTaskStore(pmRoot, authority('pm_tasks', pmRoot)).create({ kind: 'assemble', payload: {} });
    captures.push(adapter('pm_tasks', pmRoot).capture('project-native'));

    const feedbackBase = root(); process.env.SANGFOR_FEEDBACK_ROOT = feedbackBase; process.env.SANGFOR_ENGAGEMENT_ID = 'project-native';
    const feedbackRoot = resolveEngagementScopedData('data/feedback', 'SANGFOR_FEEDBACK_ROOT');
    const feedbackAuthority = authority('feedback_lessons', feedbackRoot);
    const feedback = await submitFeedback({ product: 'HCI', feedbackType: 'quality', severity: 'medium', feedbackText: 'text', sourceRole: 'engineer' }, feedbackAuthority);
    await extractLesson(feedback.id, feedbackAuthority); captures.push(adapter('feedback_lessons', feedbackRoot).capture('project-native'));

    const evalRoot = root(); process.env.SANGFOR_EVALS_ROOT = evalRoot;
    await createEvalCaseFromFeedback({ product: 'HCI', name: 'eval', requiredText: 'MTU' }, authority('evals', evalRoot));
    captures.push(adapter('evals', evalRoot).capture('project-native'));

    const wikiRoot = root(); process.env.SANGFOR_WIKI_ROOT = wikiRoot; const wikiAuthority = authority('wiki_proposals', wikiRoot);
    await proposeWikiUpdate({ lessonTitle: 'lesson', lessonBody: 'body' }, wikiAuthority);
    await upsertKnowledgeCard({ type: 'procedure', product: 'HCI', title: 'card', prerequisites: [], steps: [], warnings: [], verification: [], rollback: [], citations: [{ sourceId: 's', spanText: 'q', quoteHash: 'a'.repeat(64) }], trustLevel: 'internal' }, wikiAuthority);
    captures.push(adapter('wiki_proposals', wikiRoot).capture('project-native'));

    const learningRoot = root(); const learningPath = join(learningRoot, 'strategy.json');
    const manager = new StrategyStoreManager(learningPath, authority('learning_strategy_lifecycle', learningRoot));
    await manager.commit(manager.createStrategy('strategy-1'), 0); captures.push(adapter('learning_strategy_lifecycle', learningRoot).capture('project-native'));

    const chronicleRoot = root(); await recordSnapshot({ deviceId: 'device-1', observed: { mtu: 1500 }, capturedAt: '2026-08-26T00:00:00.000Z', dir: chronicleRoot, authority: authority('config_chronicle_state', chronicleRoot) });
    captures.push(adapter('config_chronicle_state', chronicleRoot).capture('project-native'));

    const capabilityRoot = root(); const ledgerPath = join(capabilityRoot, 'ledger.jsonl'); const ledgerSecret = 'l'.repeat(32); const checkpointSecret = 'c'.repeat(32);
    const ledger = await FilePromotionLedger.initialize(ledgerPath, ledgerSecret, checkpointSecret, {}, authority('capability_evidence_promotion', capabilityRoot));
    await ledger.append({ version: 1, eventId: evidenceIdSchema.parse('event-1'), at: '2026-08-26T00:00:00.000Z', outcome: 'rejected', action: 'reject', target: {
      productId: evidenceIdSchema.parse('p'), capabilityId: evidenceIdSchema.parse('c'),
      toolId: evidenceIdSchema.parse('t'), workAtomIds: [evidenceIdSchema.parse('w')],
    }, fromMaturity: 'planned', toMaturity: 'planned', decisionRef: sha256Schema.parse('a'.repeat(64)), manifestRef: sha256Schema.parse('b'.repeat(64)), nonceRef: null, refusalCode: evidenceIdSchema.parse('refused') });
    captures.push(adapter('capability_evidence_promotion', capabilityRoot, { ledger: ledgerSecret, checkpoint: checkpointSecret }).capture('project-native'));

    const snapshots = await Promise.all(captures);
    expect(snapshots).toHaveLength(11);
    expect(snapshots.every((snapshot) => typeof snapshot === 'object' && snapshot !== null && 'records' in snapshot && snapshot.records.length > 0)).toBe(true);
  });
});
