import { z } from 'zod';
import {
  parseBoundaryChronicleCanonicalV1,
  parseBoundaryChronicleChainV1,
} from '../../packages/sangfor-chronicle/src/runtime-boundaries.js';
import {
  parseBoundaryCollectorArticleDataV1,
  parseBoundaryCollectorCheckpointV1,
  parseBoundaryCollectorManifestV1,
  parseBoundaryCollectorReportV1,
} from '../../packages/sangfor-collector/src/runtime-boundaries.js';
import {
  parseBoundaryEngineerCanonicalCloneV1,
  parseBoundaryEngineerEvaluationCloneV1,
  parseBoundaryEngineerGoldenFixtureV1,
  parseBoundaryEngineerReportLineV1,
} from '../../packages/sangfor-engineer-report/src/runtime-boundaries.js';
import { parseBoundaryEvidenceLedgerLineV1 } from '../../packages/sangfor-evidence/src/runtime-boundaries.js';
import { parseBoundaryFinetuneDatasetLineV1 } from '../../packages/sangfor-finetune/src/runtime-boundaries.js';
import { parseBoundaryHciAuditLineV1 } from '../../packages/sangfor-hci-client/src/runtime-boundaries.js';
import { parseBoundaryJmCdpMessageV1 } from '../../packages/sangfor-jm-execution/src/runtime-boundaries.js';
import { parseBoundaryLearningStrategyStoreV1 } from '../../packages/sangfor-learning-strategy/src/runtime-boundaries.js';
import {
  REJECTED_RUNTIME_SECRET,
  type RuntimeBoundaryCase,
} from './runtime-boundary-case.js';

const stats = { discovered: 0, fetched: 0, accepted: 0, rejected: {}, duplicates: 0, errors: 0 };
const collectedDocument = {
  id: 'doc-1', source: 'knowledge', sourceUrl: 'https://example.invalid/doc', product: 'HCI',
  title: 'title', text: 'text', trustLevel: 'official', fetchedAt: '2026-08-27T00:00:00.000Z',
};
const checkpoint = {
  version: 1, completed: false, documents: [], contentHashes: [], support: stats, community: stats,
  limitState: {
    supportLimitReached: false,
    communityForumLimitApplied: false,
    communityPageLimitApplied: false,
    communityThreadLimitApplied: false,
  },
};
const siteReport = {
  startedAt: '2026-08-27T00:00:00.000Z', completedAt: '2026-08-27T00:00:01.000Z',
  sourceRoots: [], support: stats, community: stats, documents: 0,
  frontierExhausted: true, truncatedByLimit: [],
};
const evaluation = {
  specId: 'spec-1', ok: false, items: [],
  summary: { pass: 0, fail: 0, indeterminate: 0, misconfiguration: 0, missing: 0, contextDependent: 0 },
  coverage: { specifiedTotal: 0, observedTotal: 0, unspecifiedKeys: [], unobservedItems: [] },
};
const spec = { id: 'spec-1', product: 'HCI', version: '1.0', items: [] };
const hash = 'a'.repeat(64);
const report = {
  schemaVersion: 1, reportId: 'report-1', deviceId: 'device-1', snapshotHash: hash,
  engineResult: evaluation, riskNote: '', recommendations: [], rollbackPlan: [], ragCitations: [],
  modelId: 'model-1', promptHash: hash, createdAt: '2026-08-27T00:00:00.000Z',
};
const ledgerLine = {
  seq: 0, at: '2026-08-27T00:00:00.000Z', runId: 'run-1', kind: 'state',
  payload: { state: 'PENDING' }, prevHash: 'GENESIS', hash: 'hash-1', keyed: false,
};
const simpleCodec = {
  schema: z.object({ value: z.string().max(100) }).strict(),
  schemaName: 'test.canonical-value.v1',
};

export const runtimeBoundaryDomainACases: readonly RuntimeBoundaryCase[] = [
  {
    id: 'CHRONICLE_CANONICAL', policy: 'loud_failure', schemaName: 'chronicle.canonical-observation.v1',
    parse: parseBoundaryChronicleCanonicalV1,
    valid: { cpu: 10 }, invalid: [REJECTED_RUNTIME_SECRET],
  },
  {
    id: 'CHRONICLE_CHAIN', policy: 'freeze', schemaName: 'chronicle.chain.v1',
    parse: parseBoundaryChronicleChainV1,
    valid: { deviceId: 'device-1', snapshots: [] },
    invalid: { deviceId: 'device-1', snapshots: [], token: REJECTED_RUNTIME_SECRET },
  },
  {
    id: 'COLLECTOR_ARTICLE_DATA', policy: 'deny', schemaName: 'collector.article-data.v1',
    parse: parseBoundaryCollectorArticleDataV1,
    valid: { articleId: 'article-1', articleType: 1 },
    invalid: { articleId: 'article-1', token: REJECTED_RUNTIME_SECRET },
  },
  {
    id: 'COLLECTOR_MANIFEST', policy: 'freeze', schemaName: 'collector.manifest.v1',
    parse: parseBoundaryCollectorManifestV1,
    valid: [collectedDocument], invalid: [{ ...collectedDocument, token: REJECTED_RUNTIME_SECRET }],
  },
  {
    id: 'COLLECTOR_CHECKPOINT', policy: 'freeze', schemaName: 'collector.site-checkpoint.v1',
    parse: parseBoundaryCollectorCheckpointV1,
    valid: checkpoint, invalid: { ...checkpoint, token: REJECTED_RUNTIME_SECRET },
  },
  {
    id: 'COLLECTOR_REPORT', policy: 'invalid_report', schemaName: 'collector.site-report.v1',
    parse: parseBoundaryCollectorReportV1,
    valid: siteReport, invalid: { ...siteReport, token: REJECTED_RUNTIME_SECRET },
  },
  {
    id: 'ENGINEER_CANONICAL_CLONE', policy: 'loud_failure', schemaName: 'engineer-report.canonical-clone.v1',
    parse: (source) => parseBoundaryEngineerCanonicalCloneV1(source, simpleCodec),
    valid: { value: 'ok' }, invalid: { value: 'ok', token: REJECTED_RUNTIME_SECRET },
  },
  {
    id: 'ENGINEER_GOLDEN_FIXTURE', policy: 'invalid_report', schemaName: 'engineer-report.golden-fixture.v1',
    parse: parseBoundaryEngineerGoldenFixtureV1,
    valid: {
      vendor: 'fortios', firmware: '1.0', rawPayload: {}, allowlist: [], expectedObserved: {},
      spec, evaluatedAt: '2026-08-27T00:00:00.000Z', expectedVerdicts: {},
    },
    invalid: {
      vendor: 'fortios', firmware: '1.0', rawPayload: {}, allowlist: [], expectedObserved: {},
      spec, evaluatedAt: '2026-08-27T00:00:00.000Z', expectedVerdicts: {}, token: REJECTED_RUNTIME_SECRET,
    },
  },
  {
    id: 'ENGINEER_REPORT_LINE', policy: 'invalid_report', schemaName: 'engineer-report.ledger-line.v1',
    parse: parseBoundaryEngineerReportLineV1,
    valid: { seq: 1, prevHash: 'GENESIS', hash, report },
    invalid: { seq: 1, prevHash: 'GENESIS', hash, report, token: REJECTED_RUNTIME_SECRET },
  },
  {
    id: 'ENGINEER_EVALUATION_CLONE', policy: 'loud_failure', schemaName: 'engineer-report.evaluation-result.v1',
    parse: parseBoundaryEngineerEvaluationCloneV1,
    valid: evaluation, invalid: { ...evaluation, token: REJECTED_RUNTIME_SECRET },
  },
  {
    id: 'EVIDENCE_LEDGER_LINE', policy: 'INDETERMINATE', schemaName: 'evidence.change-run-ledger-line.v1',
    parse: parseBoundaryEvidenceLedgerLineV1,
    valid: ledgerLine, invalid: { ...ledgerLine, token: REJECTED_RUNTIME_SECRET },
  },
  {
    id: 'FINETUNE_DATASET_LINE', policy: 'deny', schemaName: 'finetune.dataset-line.v1',
    parse: parseBoundaryFinetuneDatasetLineV1,
    valid: { messages: [
      { role: 'system', content: 's' }, { role: 'user', content: 'u' }, { role: 'assistant', content: 'a' },
    ] },
    invalid: { messages: [], token: REJECTED_RUNTIME_SECRET },
  },
  {
    id: 'HCI_AUDIT_LINE', policy: 'INDETERMINATE', schemaName: 'hci-client.audit-ledger-line.v1',
    parse: parseBoundaryHciAuditLineV1,
    valid: ledgerLine, invalid: { ...ledgerLine, token: REJECTED_RUNTIME_SECRET },
  },
  {
    id: 'JM_CDP_MESSAGE', policy: 'INDETERMINATE', schemaName: 'jm-execution.cdp-message.v1',
    parse: parseBoundaryJmCdpMessageV1,
    valid: { id: 1, result: {} }, invalid: { id: 1, result: {}, token: REJECTED_RUNTIME_SECRET },
  },
  {
    id: 'LEARNING_STRATEGY_STORE', policy: 'freeze', schemaName: 'learning-strategy.store.v1',
    parse: parseBoundaryLearningStrategyStoreV1,
    valid: { schemaVersion: 1, strategyId: 'strategy-1', generations: [], currentGeneration: 0, mirrorOutbox: [], mirrorReceipts: [], lifecycleEvents: [] },
    invalid: { schemaVersion: 1, strategyId: 'strategy-1', generations: [], currentGeneration: 0, mirrorOutbox: [], mirrorReceipts: [], lifecycleEvents: [], token: REJECTED_RUNTIME_SECRET },
  },
];
