import { createHash, createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AUTHORITY_ADAPTER_POLICIES,
  FilesystemCutoverSourceAdapter,
} from '../packages/sangfor-authority/src/index.js';
import { canonicalJson } from '../packages/sangfor-authority/src/cutover/records.js';
import { filesBelow } from '../packages/sangfor-authority/src/cutover/source-files.js';

const roots: string[] = [];
const root = (): string => { const value = mkdtempSync(join(tmpdir(), 'cutover-source-')); roots.push(value); return value; };
const expectedFiles = (base: string): readonly string[] => filesBelow(base, () => true).map((file) => file.relativePath);
const put = (base: string, path: string, value: unknown, lines = false): void => {
  const target = join(base, path); mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, lines ? `${JSON.stringify(value)}\n` : JSON.stringify(value));
};
afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }); });

const report = {
  schemaVersion: 1, reportId: 'report-1', deviceId: 'device-1', snapshotHash: 'snapshot',
  engineResult: {}, riskNote: '', recommendations: [], rollbackPlan: [], ragCitations: [],
  modelId: 'model', promptHash: 'prompt', createdAt: '2026-08-26T00:00:00.000Z',
};
const auditBody = { ok: true };
const auditMaterial = `GENESIS\n0\nrequest\n${JSON.stringify(auditBody)}`;
const promotionUnsigned = {
  version: 1, eventId: 'event-1', seq: 0, at: '2026-08-26T00:00:00.000Z', outcome: 'applied', action: 'promote',
  target: { productId: 'p', capabilityId: 'c', toolId: 't', workAtomIds: ['w'] },
  fromMaturity: 'tested_mock', toMaturity: 'tested_lab', decisionRef: 'd'.repeat(64), manifestRef: 'm'.repeat(64),
  nonceRef: 'n'.repeat(64), refusalCode: null, prevHash: 'GENESIS',
} as const;

function fixture(aggregate: string): {
  readonly sourceRoot: string; readonly auditSecret?: string;
  readonly promotionLedgerSecret?: string; readonly promotionCheckpointSecret?: string;
} {
  const base = root();
  switch (aggregate) {
    case 'registry_services':
      put(base, 'data/registry/devices.json', [{ id: 'd', name: 'D', product: 'HCI', host: 'h', tags: [], createdAt: '2026-08-26T00:00:00.000Z', updatedAt: '2026-08-26T00:00:00.000Z' }]);
      put(base, 'data/registry/playbooks.json', []);
      put(base, 'data/registry/vendors.json', [{ product: 'HCI', label: 'HCI', advisorTools: [], credentialFields: [] }]); break;
    case 'runs_steps':
      put(base, 'data/runs/2026-08-26.jsonl', { schemaVersion: 1, runId: 'run-1', toolId: 'tool', toolSafety: 'read_only', args: {}, status: 'succeeded', requestedAt: '2026-08-26T00:00:00.000Z' }, true); break;
    case 'audit':
      put(base, 'data/evidence/change-runs/run.jsonl', { seq: 0, at: '2026-08-26T00:00:00.000Z', runId: 'run-1', kind: 'request', payload: auditBody, prevHash: 'GENESIS', hash: createHash('sha256').update(auditMaterial).digest('hex'), keyed: false }, true); break;
    case 'evidence': {
      const hash = createHash('sha256').update(`GENESIS|${canonicalJson(report)}`).digest('hex');
      put(base, 'evidence/engineer-reports.jsonl', { seq: 1, prevHash: 'GENESIS', hash, report }, true); break;
    }
    case 'pm_tasks':
      put(base, 'data/registry/agent-tasks.json', [{ id: 'task-1', kind: 'assemble', payload: {}, status: 'open', createdAt: '2026-08-26T00:00:00.000Z' }]); break;
    case 'feedback_lessons':
      put(base, 'data/feedback/feedback.jsonl', { id: 'feedback-1', product: 'HCI', feedbackType: 'quality', severity: 'medium', feedbackText: 'text', sourceRole: 'engineer', status: 'new' }, true);
      writeFileSync(join(base, 'data/feedback/lessons.jsonl'), ''); break;
    case 'evals':
      put(base, 'data/evals/eval-cases.jsonl', { id: 'eval-1', name: 'name', product: 'HCI', requiredText: 'MTU' }, true); break;
    case 'wiki_proposals':
      put(base, 'data/wiki/proposals.jsonl', { id: 'wiki-1', targetPage: 'p', title: 't', beforeText: '', afterText: 'a', status: 'pending' }, true);
      writeFileSync(join(base, 'data/wiki/knowledge-cards.jsonl'), ''); break;
    case 'learning_strategy_lifecycle':
      put(base, 'strategy.json', { schemaVersion: 1, strategyId: 'strategy-1', generations: [], currentGeneration: 0, mirrorOutbox: [], mirrorReceipts: [], lifecycleEvents: [] }); break;
    case 'config_chronicle_state':
      put(base, 'device.json', { deviceId: 'device-1', snapshots: [] }); break;
    case 'capability_evidence_promotion': {
      const secret = 'promotion-test-secret'; const checkpointSecret = 'checkpoint-test-secret';
      const hash = createHmac('sha256', secret).update(`sangfor.capability-promotion-ledger.v1\n${canonicalJson(promotionUnsigned)}`).digest('hex');
      put(base, 'ledger.jsonl', { ...promotionUnsigned, hash }, true);
      const hmac = createHmac('sha256', checkpointSecret).update(`sangfor.capability-promotion-checkpoint.v1\n1\n1\n${hash}`).digest('hex');
      put(base, 'ledger.jsonl.head.json', { version: 1, eventCount: 1, lastHash: hash, hmac });
      return { sourceRoot: base, promotionLedgerSecret: secret, promotionCheckpointSecret: checkpointSecret };
    }
    default: throw new Error(`unknown fixture ${aggregate}`);
  }
  return { sourceRoot: base };
}

describe('aggregate-owned filesystem cutover sources', () => {
  it('captures every backfill policy from generated source without changing source bytes', async () => {
    const policies = AUTHORITY_ADAPTER_POLICIES.filter((entry) => entry.policy === 'backfill');
    expect(policies).toHaveLength(11);
    for (const policy of policies) {
      const options = fixture(policy.aggregate);
      const before = sourceDigest(options.sourceRoot);
      const adapter = new FilesystemCutoverSourceAdapter({ aggregate: policy.aggregate, tenantId: 'tenant', expectedFiles: expectedFiles(options.sourceRoot), ...options });
      const first = await adapter.capture('project'); const second = await adapter.capture('project');
      const expectedCount = ['registry_services', 'capability_evidence_promotion'].includes(policy.aggregate) ? 2 : 1;
      expect(first.records).toHaveLength(expectedCount); expect(second.highWaterMark).toBe(first.highWaterMark);
      const after = sourceDigest(options.sourceRoot);
      expect(after).toBe(before);
    }
  });

  it('refuses symlinked source files and exact-set extras', async () => {
    const symlinked = root(); const outside = root();
    put(outside, 'eval.jsonl', { id: 'eval-1', name: 'n', product: 'HCI', requiredText: 'x' }, true);
    mkdirSync(join(symlinked, 'data/evals'), { recursive: true });
    symlinkSync(join(outside, 'eval.jsonl'), join(symlinked, 'data/evals/eval-cases.jsonl'));
    await expect(new FilesystemCutoverSourceAdapter({
      aggregate: 'evals', tenantId: 'tenant', sourceRoot: symlinked,
      expectedFiles: ['data/evals/eval-cases.jsonl'],
    }).capture('p')).rejects.toThrow('CUTOVER_SOURCE_SYMLINK_REFUSED');
    const extra = root();
    put(extra, 'data/evals/eval-cases.jsonl', { id: 'eval-1', name: 'n', product: 'HCI', requiredText: 'x' }, true);
    put(extra, 'data/evals/unknown.jsonl', { id: 'invented' }, true);
    await expect(new FilesystemCutoverSourceAdapter({
      aggregate: 'evals', tenantId: 'tenant', sourceRoot: extra,
      expectedFiles: ['data/evals/eval-cases.jsonl'],
    }).capture('p')).rejects.toThrow('CUTOVER_SOURCE_FILE_SET_MISMATCH');
  });

  it('fails closed on unknown fields and chain tampering', async () => {
    const invalid = root();
    put(invalid, 'data/evals/eval-cases.jsonl', { id: 'eval-1', name: 'n', product: 'HCI', requiredText: 'x', invented: true }, true);
    await expect(new FilesystemCutoverSourceAdapter({ aggregate: 'evals', tenantId: 'tenant', sourceRoot: invalid, expectedFiles: expectedFiles(invalid) }).capture('p'))
      .rejects.toThrow('CUTOVER_SOURCE_INVALID');
    const broken = root();
    put(broken, 'data/evidence/change-runs/run.jsonl', { seq: 1, at: '2026-08-26T00:00:00.000Z', runId: 'r', kind: 'request', payload: {}, prevHash: 'GENESIS', hash: 'bad', keyed: false }, true);
    await expect(new FilesystemCutoverSourceAdapter({ aggregate: 'audit', tenantId: 'tenant', sourceRoot: broken, expectedFiles: expectedFiles(broken) }).capture('p'))
      .rejects.toThrow('CUTOVER_CHAIN_GAP');
  });
});

function sourceDigest(base: string): string {
  const hash = createHash('sha256');
  for (const file of filesBelow(base, () => true)) hash.update(file.relativePath).update(file.bytes);
  return hash.digest('hex');
}
