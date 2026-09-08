import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { signLearningApproval, type LearningApprovalPayload } from '../packages/sangfor-learning-strategy/src/approval.js';
import { LearningStrategyService, type PromoteStrategyRequest } from '../packages/sangfor-learning-strategy/src/service.js';

const roots: string[] = [];
const originalEnv = { ...process.env };
afterEach(() => {
  process.env = { ...originalEnv };
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const STRATEGY_ID = 'endpoint-authority';
const EVIDENCE = '{"verified":true}\n';
const OTHER_SECRET = Buffer.alloc(32, 9).toString('base64');

interface Fixture {
  subject: LearningStrategyService;
  storeRoot: string;
  storePath: string;
  evidenceRoot: string;
  payload: LearningApprovalPayload;
}

/**
 * A draft revision, a confined evidence file, an isolated nonce store, and the
 * exactly-bound approval payload for `draft -> researched`.
 */
async function fixture(): Promise<Fixture> {
  const storeRoot = mkdtempSync(join(tmpdir(), 'strategy-authority-store-'));
  const evidenceRoot = mkdtempSync(join(tmpdir(), 'strategy-authority-evidence-'));
  roots.push(storeRoot, evidenceRoot);
  writeFileSync(join(evidenceRoot, 'approval.json'), EVIDENCE, { mode: 0o600 });
  const subject = new LearningStrategyService(storeRoot);
  const created = await subject.research({
    strategyId: STRATEGY_ID, vendor: 'SANGFOR',
    scope: { product: 'ENDPOINT_SECURE', firmwareVersion: '6.0.4' },
    registryDigest: 'a'.repeat(64), versionTruthRecord: 'truth-604',
    officialCitation: 'https://support.example.invalid/manual', pageVerified: true,
    captureEvidenceFile: 'approval.json',
  });
  process.env.SANGFOR_LEARNING_APPROVAL_SECRET = Buffer.alloc(32, 7).toString('base64');
  // A subdirectory, not a sibling file: the store root is enumerated as strategy JSON.
  process.env.SANGFOR_LEARNING_NONCE_STORE_PATH = join(storeRoot, 'nonces', 'approval-nonces.json');
  return {
    subject, storeRoot, evidenceRoot,
    storePath: join(storeRoot, `${STRATEGY_ID}.json`),
    payload: {
      entityType: 'strategy', entityId: STRATEGY_ID, revisionId: created.revision.revisionId,
      contentHash: created.revision.contentHash, fromState: 'draft', toState: 'researched',
      evidenceFile: 'approval.json', evidenceDigest: createHash('sha256').update(EVIDENCE).digest('hex'),
      nonce: 'a'.repeat(64), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  };
}

function promoteRequest(context: Fixture, payload: LearningApprovalPayload, approvalToken: string): PromoteStrategyRequest {
  return {
    strategyId: STRATEGY_ID, revisionId: context.payload.revisionId, toState: 'researched',
    evidenceFile: 'approval.json', evidenceDigest: context.payload.evidenceDigest,
    approvalPayload: payload, approvalToken, evidenceRoot: context.evidenceRoot,
  };
}

function storeBytes(storePath: string): string {
  return readFileSync(storePath, 'utf8');
}

describe('learning-strategy authority-bound persistence', () => {
  it('commits the promoted revision and its approval event only through the verified approval', async () => {
    // Given: a draft revision and an approval signed over the exact transition.
    const context = await fixture();
    const before = storeBytes(context.storePath);
    // When: the promotion runs with a valid token.
    const result = await context.subject.promote(promoteRequest(context, context.payload, signLearningApproval(context.payload)));
    // Then: the new revision, its derivation, and exactly one lifecycle event are persisted.
    const persisted = JSON.parse(storeBytes(context.storePath)) as {
      lifecycleEvents: { domain: string; payload: LearningApprovalPayload }[];
    };
    expect(result.revision).toMatchObject({ state: 'researched', derivedFromRevisionId: context.payload.revisionId });
    expect(result.event.payload).toEqual(context.payload);
    expect(persisted.lifecycleEvents).toHaveLength(1);
    expect(persisted.lifecycleEvents[0]).toMatchObject({ domain: 'learning-strategy-v1', payload: context.payload });
    expect(storeBytes(context.storePath)).not.toBe(before);
    expect(context.subject.validate({ strategyId: STRATEGY_ID, revisionId: result.revision.revisionId, evidenceFile: 'approval.json' }).revision.state)
      .toBe('researched');
  });

  it('persists nothing when the approval token was signed by a different secret', async () => {
    // Given: a correctly bound payload signed with a foreign secret.
    const context = await fixture();
    const before = storeBytes(context.storePath);
    const foreignToken = signLearningApproval(context.payload, OTHER_SECRET);
    // When: the promotion is attempted.
    // Then: it fails on the signature and the store file is byte-identical.
    await expect(context.subject.promote(promoteRequest(context, context.payload, foreignToken))).rejects.toThrow('SIGNATURE_MISMATCH');
    expect(storeBytes(context.storePath)).toBe(before);
  });

  it('persists nothing when the approval binds a different target state than the request', async () => {
    // Given: an approval signed for `deprecated` replayed against a `researched` request.
    const context = await fixture();
    const before = storeBytes(context.storePath);
    const substituted = { ...context.payload, toState: 'deprecated', nonce: 'b'.repeat(64) };
    // When: the promotion is attempted with that validly signed but mis-bound approval.
    // Then: the binding check refuses and nothing reaches the store.
    await expect(context.subject.promote(promoteRequest(context, substituted, signLearningApproval(substituted))))
      .rejects.toThrow('APPROVAL_BINDING_MISMATCH');
    expect(storeBytes(context.storePath)).toBe(before);
  });

  it('persists nothing when the approval binds a different revision than the request', async () => {
    // Given: an approval bound to a revision id the request does not name.
    const context = await fixture();
    const before = storeBytes(context.storePath);
    const foreign = { ...context.payload, revisionId: '00000000-0000-4000-8000-000000000000' };
    // When: the promotion names the foreign revision id.
    // Then: the exact-revision binding refuses and nothing is written.
    await expect(context.subject.promote({
      ...promoteRequest(context, foreign, signLearningApproval(foreign)),
      revisionId: context.payload.revisionId,
    })).rejects.toThrow('APPROVAL_BINDING_MISMATCH');
    expect(storeBytes(context.storePath)).toBe(before);
  });

  it('persists nothing when the requested transition is not on the lifecycle table', async () => {
    // Given: an approval bound to `draft -> device_verified`, which the table forbids.
    const context = await fixture();
    const before = storeBytes(context.storePath);
    const payload = { ...context.payload, toState: 'device_verified' };
    // When: the promotion is attempted.
    // Then: the transition gate refuses ahead of any approval work.
    await expect(context.subject.promote({
      ...promoteRequest(context, payload, signLearningApproval(payload)),
      toState: 'device_verified',
    })).rejects.toThrow('INVALID_TRANSITION: draft -> device_verified');
    expect(storeBytes(context.storePath)).toBe(before);
  });

  it('persists nothing when the evidence on disk does not hash to the approved digest', async () => {
    // Given: an approval whose evidence digest was minted before the file changed.
    const context = await fixture();
    writeFileSync(join(context.evidenceRoot, 'approval.json'), '{"verified":false}\n', { mode: 0o600 });
    const before = storeBytes(context.storePath);
    // When: the promotion is attempted.
    // Then: the evidence binding refuses and nothing is written.
    await expect(context.subject.promote(promoteRequest(context, context.payload, signLearningApproval(context.payload))))
      .rejects.toThrow('INVALID_PAYLOAD');
    expect(storeBytes(context.storePath)).toBe(before);
  });

  it('persists nothing when the approval has expired', async () => {
    // Given: an approval whose expiry is already in the past.
    const context = await fixture();
    const before = storeBytes(context.storePath);
    const expired = { ...context.payload, expiresAt: new Date(Date.now() - 1_000).toISOString() };
    // When: the promotion is attempted.
    // Then: expiry refuses and nothing is written.
    await expect(context.subject.promote(promoteRequest(context, expired, signLearningApproval(expired))))
      .rejects.toThrow('APPROVAL_EXPIRED');
    expect(storeBytes(context.storePath)).toBe(before);
  });

  it('persists nothing when the approval secret is not configured', async () => {
    // Given: a fixture whose signing secret is removed after the token was minted.
    const context = await fixture();
    const approvalToken = signLearningApproval(context.payload);
    const before = storeBytes(context.storePath);
    delete process.env.SANGFOR_LEARNING_APPROVAL_SECRET;
    // When: the promotion is attempted.
    // Then: the missing secret fails closed and nothing is written.
    await expect(context.subject.promote(promoteRequest(context, context.payload, approvalToken))).rejects.toThrow('SECRET_NOT_CONFIGURED');
    expect(storeBytes(context.storePath)).toBe(before);
  });

  it('refuses to replay a consumed nonce and leaves the promoted state as the only committed one', async () => {
    // Given: one promotion already committed with a single-use nonce.
    const context = await fixture();
    const approvalToken = signLearningApproval(context.payload);
    const promoted = await context.subject.promote(promoteRequest(context, context.payload, approvalToken));
    const after = storeBytes(context.storePath);
    // When: the identical approval is replayed.
    // Then: the replay is refused and the store is unchanged from the single commit.
    await expect(context.subject.promote(promoteRequest(context, context.payload, approvalToken))).rejects.toThrow('NONCE_REPLAY');
    expect(storeBytes(context.storePath)).toBe(after);
    const persisted = JSON.parse(after) as { lifecycleEvents: unknown[] };
    expect(persisted.lifecycleEvents).toHaveLength(1);
    expect(context.subject.list({ strategyId: STRATEGY_ID }).items.filter((item) => item.status === 'researched'))
      .toHaveLength(1);
    expect(promoted.revision.state).toBe('researched');
  });

  it('confines promotion writes to the strategy file of the named strategy', async () => {
    // Given: a second strategy in the same root.
    const context = await fixture();
    await context.subject.research({
      strategyId: 'endpoint-bystander', vendor: 'SANGFOR',
      scope: { product: 'ENDPOINT_SECURE', firmwareVersion: '6.0.5' },
      registryDigest: 'a'.repeat(64), versionTruthRecord: 'truth-605',
      officialCitation: 'https://support.example.invalid/manual', pageVerified: true,
      captureEvidenceFile: 'approval.json',
    });
    const bystanderPath = join(context.storeRoot, 'endpoint-bystander.json');
    const before = storeBytes(bystanderPath);
    // When: the first strategy is promoted.
    await context.subject.promote(promoteRequest(context, context.payload, signLearningApproval(context.payload)));
    // Then: the bystander store is untouched and no extra store file appeared.
    expect(storeBytes(bystanderPath)).toBe(before);
    expect(readdirSync(context.storeRoot).filter((name) => name.endsWith('.json')).sort())
      .toEqual(['endpoint-authority.json', 'endpoint-bystander.json']);
  });
});
