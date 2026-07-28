import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LearningStrategyService } from '../packages/sangfor-learning-strategy/src/service.js';
import { signLearningApproval, type LearningApprovalPayload } from '../packages/sangfor-learning-strategy/src/approval.js';

const roots: string[] = [];
const originalEnv = { ...process.env };
afterEach(() => {
  process.env = { ...originalEnv };
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function service(): LearningStrategyService {
  const root = mkdtempSync(join(tmpdir(), 'strategy-service-'));
  roots.push(root);
  return new LearningStrategyService(root);
}

describe('LearningStrategyService', () => {
  it('persists a researched draft and lists it through exact filters', () => {
    const subject = service();
    const created = subject.research({
      strategyId: 'endpoint-version', vendor: 'SANGFOR',
      scope: { product: 'ENDPOINT_SECURE', firmwareVersion: '6.0.4', fact: 'version' },
      registryDigest: 'a'.repeat(64), versionTruthRecord: 'truth-604',
      officialCitation: 'https://support.example.invalid/manual', pageVerified: true,
    });
    expect(created.revision.state).toBe('draft');
    expect(created.evidenceGaps).toEqual(['capture evidence is not supplied']);
    expect(subject.list({ product: 'ENDPOINT_SECURE', firmwareVersion: '6.0.4' }).items).toHaveLength(1);
  });

  it('fails closed on registry drift and never returns a near product match', () => {
    const subject = service();
    subject.research({
      strategyId: 'endpoint-version', vendor: 'SANGFOR',
      scope: { product: 'ENDPOINT_SECURE', firmwareVersion: '6.0.4' },
      registryDigest: 'a'.repeat(64), versionTruthRecord: 'truth-604',
      officialCitation: 'https://support.example.invalid/manual', pageVerified: true,
    });
    expect(subject.resolve(
      { product: 'ENDPOINT_SECURE', firmwareVersion: '6.0.4' },
      { registryDigest: 'b'.repeat(64), versionTruthRecord: 'truth-604', environment: 'lab' },
    )).toMatchObject({ code: 'REGISTRY_DRIFT' });
    expect(subject.resolve(
      { product: 'ENDPOINT_SECURE', firmwareVersion: '6.0.5' },
      { registryDigest: 'a'.repeat(64), versionTruthRecord: 'truth-604', environment: 'lab' },
    )).toMatchObject({ code: 'NO_ELIGIBLE_STRATEGY' });
  });

  it('rejects credential fields recursively', () => {
    const subject = service();
    expect(() => subject.resolve(
      { product: 'ENDPOINT_SECURE', firmwareVersion: '6.0.4', password: 'x' } as never,
      { registryDigest: 'a'.repeat(64), versionTruthRecord: 'truth' },
    )).toThrow('SECRET_FIELD_FORBIDDEN');
  });

  it('promotes a signed exact revision atomically and rejects approval target substitution', () => {
    const storeRoot = mkdtempSync(join(tmpdir(), 'strategy-promote-store-'));
    const evidenceRoot = mkdtempSync(join(tmpdir(), 'strategy-promote-evidence-'));
    roots.push(storeRoot, evidenceRoot);
    const subject = new LearningStrategyService(storeRoot);
    const evidence = '{"verified":true}\n';
    mkdirSync(evidenceRoot, { recursive: true });
    writeFileSync(join(evidenceRoot, 'approval.json'), evidence, { mode: 0o600 });
    const created = subject.research({
      strategyId: 'endpoint-promote', vendor: 'SANGFOR',
      scope: { product: 'ENDPOINT_SECURE', firmwareVersion: '6.0.4' },
      registryDigest: 'a'.repeat(64), versionTruthRecord: 'truth-604',
      officialCitation: 'https://support.example.invalid/manual', pageVerified: true,
      captureEvidenceFile: 'approval.json',
    });
    const secret = Buffer.alloc(32, 7).toString('base64');
    process.env.SANGFOR_LEARNING_APPROVAL_SECRET = secret;
    process.env.SANGFOR_LEARNING_NONCE_STORE_PATH = join(storeRoot, 'nonces.json');
    const basePayload: LearningApprovalPayload = {
      entityType: 'strategy', entityId: 'endpoint-promote', revisionId: created.revision.revisionId,
      contentHash: created.revision.contentHash, fromState: 'draft', toState: 'researched',
      evidenceFile: 'approval.json', evidenceDigest: createHash('sha256').update(evidence).digest('hex'),
      nonce: 'a'.repeat(64), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const substituted = { ...basePayload, toState: 'deprecated', nonce: 'b'.repeat(64) };
    expect(() => subject.promote({
      strategyId: 'endpoint-promote', revisionId: created.revision.revisionId, toState: 'researched',
      approvalPayload: substituted, approvalToken: signLearningApproval(substituted), evidenceRoot,
      evidenceFile: 'approval.json', evidenceDigest: basePayload.evidenceDigest,
    })).toThrow('APPROVAL_BINDING_MISMATCH');
    const result = subject.promote({
      strategyId: 'endpoint-promote', revisionId: created.revision.revisionId, toState: 'researched',
      approvalPayload: basePayload, approvalToken: signLearningApproval(basePayload), evidenceRoot,
      evidenceFile: 'approval.json', evidenceDigest: basePayload.evidenceDigest,
    });
    expect(result.revision).toMatchObject({ state: 'researched', derivedFromRevisionId: created.revision.revisionId });
    expect(result.event.payload).toMatchObject({ entityId: 'endpoint-promote', revisionId: created.revision.revisionId, toState: 'researched' });
    expect(subject.validate({ strategyId: 'endpoint-promote', revisionId: result.revision.revisionId, evidenceFile: 'approval.json' }).revision.state).toBe('researched');
  });
});
