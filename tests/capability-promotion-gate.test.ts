import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FilePromotionLedger,
  buildCoverageContext,
  capabilityPromotionEnvelopeSchema,
  canonicalizeCapabilityApproval,
  executeCapabilityPromotion,
  loadMaturityPolicyStrict,
  loadWorkAtomCatalog,
  signCapabilityApproval,
  type CapabilityPromotionEnvelope,
  type PromotionLedger,
  type PromotionLedgerEvent,
  type PromotionNonceStore,
} from '../packages/sangfor-competency/src/index.js';
import { writeValidationFixture } from './helpers/capability-evidence-validation-fixture.js';
import { testPromotionLedger } from './helpers/local-write-authority.js';

const SECRET = 'promotion-only-secret-material-32-bytes-minimum';
const LEDGER_SECRET = 'promotion-ledger-secret-material-32-bytes';
const CHECKPOINT_SECRET = 'promotion-checkpoint-secret-material-32';
const NOW = new Date('2026-08-25T12:10:00.000Z');

class MemoryNonceStore implements PromotionNonceStore {
  private readonly consumed = new Set<string>();
  consume(nonce: string): { readonly ok: boolean; readonly reason?: string } {
    if (this.consumed.has(nonce)) return { ok: false, reason: 'approval nonce already used' };
    this.consumed.add(nonce);
    return { ok: true };
  }
}

class FailingLedger implements PromotionLedger {
  read(): readonly PromotionLedgerEvent[] { return []; }
  append(): never { throw new Error('disk full'); }
}

describe('action-bound capability promotion gate', () => {
  let root: string;
  let manifestSource: string;
  let promotionSource: string;
  let fixture: ReturnType<typeof writeValidationFixture>;
  let ledger: FilePromotionLedger;
  let nonceStore: MemoryNonceStore;
  let grounding: Parameters<typeof executeCapabilityPromotion>[0]['grounding'];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'capability-promotion-'));
    fixture = writeValidationFixture(root);
    manifestSource = JSON.stringify(fixture.manifest);
    const groundingRoot = new URL('./fixtures/capability-evidence/grounding/', import.meta.url).pathname;
    const catalog = loadWorkAtomCatalog(groundingRoot);
    const policy = loadMaturityPolicyStrict(groundingRoot);
    if (!catalog.ok || !policy.ok) throw new Error('grounding fixture unavailable');
    grounding = {
      atoms: catalog.atoms,
      context: buildCoverageContext({
        catalogRoot: groundingRoot,
        evidenceRoot: root,
        registeredTools: ['sangfor_evaluate_config'],
        maturityPolicy: policy.entries,
      }),
    };
    const request = {
      version: 1, requestId: 'promotion-request-1', manifestId: fixture.manifest.manifestId,
      manifestDigest: createHash('sha256').update(manifestSource).digest('hex'), target: fixture.manifest.target,
      deviceIdentityDigest: fixture.manifest.digests.deviceIdentityDigest, originDigest: fixture.manifest.digests.originDigest,
      fromMaturity: 'tested_mock', requestedMaturity: 'field_verified', requestedBy: { actorId: 'requester-1', actorType: 'ai_engineer' },
      requestedAt: '2026-08-25T12:05:00.000Z', evidenceRef: 'manifest.json', auditRef: 'promotion.jsonl',
      o5Counters: fixture.manifest.o5Counters,
    } as const;
    const unsigned = capabilityPromotionEnvelopeSchema.parse({
      version: 1, request,
      decision: {
        version: 1, decisionId: 'decision-1', requestId: request.requestId, manifestId: request.manifestId,
        manifestDigest: request.manifestDigest, target: request.target, o5Counters: request.o5Counters,
        deviceIdentityDigest: request.deviceIdentityDigest, originDigest: request.originDigest,
        fromMaturity: request.fromMaturity, reviewer: { actorId: 'human-reviewer-1', actorType: 'human_pm' }, decidedAt: NOW.toISOString(),
        auditRef: 'decision.jsonl', approvalDigest: '0'.repeat(64), nonce: 'nonce-1',
        expiresAt: '2026-08-25T12:20:00.000Z', decision: 'promote', promotedMaturity: 'field_verified',

      authorityEpoch: 0,},
    });
    promotionSource = signedSource(unsigned);
    ledger = await testPromotionLedger(join(root, 'promotion.jsonl'), LEDGER_SECRET, CHECKPOINT_SECRET);
    nonceStore = new MemoryNonceStore();
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function signedSource(envelope: CapabilityPromotionEnvelope): string {
    const decision = envelope.decision;
    if (decision === null) throw new Error('decision fixture missing');
    const approvalDigest = signCapabilityApproval(SECRET, canonicalizeCapabilityApproval(envelope));
    return JSON.stringify({ ...envelope, decision: { ...decision, approvalDigest } });
  }

  function resign(transform: (value: CapabilityPromotionEnvelope) => unknown): string {
    const parsed = capabilityPromotionEnvelopeSchema.parse(JSON.parse(promotionSource));
    return signedSource(capabilityPromotionEnvelopeSchema.parse(transform(parsed)));
  }

  async function execute(overrides: Partial<Parameters<typeof executeCapabilityPromotion>[0]> = {}) {
    return await executeCapabilityPromotion({
      manifestSource, promotionSource, grounding,
      validation: { evidenceRoot: root, filesystem: fixture.context.clock ? undefined : undefined, context: fixture.context },
      secret: SECRET, nonceStore, ledger, now: NOW,
      ...overrides,
    });
  }

  it('applies one adjacent human-approved transition and derives exact maturity from its event', async () => {
    const result = await execute();
    expect(result).toMatchObject({ status: 'applied', effectiveMaturity: 'field_verified' });
    expect(ledger.read()).toHaveLength(1);
    expect(ledger.read()[0]).toMatchObject({ outcome: 'applied', fromMaturity: 'tested_mock', toMaturity: 'field_verified' });
  });

  it.each([
    ['missing secret', { secret: undefined }],
    ['missing nonce store', { nonceStore: undefined }],
  ])('refuses %s and appends a masked rejection', async (_name, overrides) => {
    const result = await execute(overrides);
    expect(result.status).toBe('refused');
    expect(ledger.read()).toHaveLength(1);
    expect(JSON.stringify(ledger.read())).not.toContain(SECRET);
    expect(JSON.stringify(ledger.read())).not.toContain('nonce-1');
  });

  it.each([
    ['forged signature', () => promotionSource.replace(
      /"approvalDigest":"[a-f0-9]+"/u,
      `"approvalDigest":"${'f'.repeat(64)}"`,
    )],
    ['changed manifest digest', () => promotionSource.replaceAll(
      createHash('sha256').update(manifestSource).digest('hex'),
      'f'.repeat(64),
    )],
  ])('refuses %s without changing maturity', async (_name, mutate) => {
    const changed = mutate();
    const result = await execute({ promotionSource: changed });
    expect(result).toMatchObject({ status: 'refused', effectiveMaturity: 'tested_mock' });
    expect(ledger.read()[0]?.outcome).toBe('rejected');
  });

  it('refuses changed O5 counters and conflicted human roles', async () => {
    const changedCounters = { ...fixture.manifest.o5Counters, passCount: fixture.manifest.o5Counters.passCount - 1 };
    const o5Source = resign((value) => ({
      ...value,
      request: { ...value.request, o5Counters: changedCounters },
      decision: value.decision === null ? null : { ...value.decision, o5Counters: changedCounters },
    }));
    const roleSource = resign((value) => ({
      ...value,
      decision: value.decision === null ? null : {
        ...value.decision,
        reviewer: { actorId: fixture.manifest.runs[0]?.executor.actorId, actorType: 'human_pm' },
      },
    }));
    const results = await Promise.all([
      await execute({ promotionSource: o5Source }),
      await execute({ promotionSource: roleSource }),
    ]);
    expect(results.every(({ status }) => status === 'refused')).toBe(true);
    expect(ledger.read().every(({ outcome }) => outcome === 'rejected')).toBe(true);
  });

  it('refuses skipped upward maturity and human-only targets', async () => {
    const plannedGrounding = {
      ...grounding,
      context: buildCoverageContext({
        catalogRoot: grounding.context.catalogRoot,
        evidenceRoot: root,
        registeredTools: ['sangfor_evaluate_config'],
        maturityPolicy: [{ product: 'HCI_SCP', capabilityId: 'resource_inventory', maturity: 'planned' }],
      }),
    };
    const humanGrounding = {
      ...grounding,
      atoms: grounding.atoms.map((atom) => atom.id === 'op_daily_health' ? { ...atom, automatability: 'human' as const } : atom),
    };
    const skipped = await execute({ grounding: plannedGrounding });
    const human = await execute({ grounding: humanGrounding });
    expect([skipped.status, human.status]).toEqual(['refused', 'refused']);
    expect(ledger.read()).toHaveLength(2);
  });

  it('refuses evidence that is no longer active before consuming the nonce', async () => {
    const result = await execute({
      validation: {
        evidenceRoot: root,
        context: {
          ...fixture.context,
          currentDigests: { ...fixture.context.currentDigests, toolDigest: fixture.context.currentDigests.recipeDigest },
        },
      },
    });
    expect(result).toMatchObject({ status: 'refused', refusalCode: 'identity_drift' });
    expect((await execute()).status).toBe('applied');
  });

  it('permits a human-approved emergency downward move', async () => {
    expect((await execute()).status).toBe('applied');
    const demotionSource = resign((value) => {
      if (value.decision === null || value.decision.decision !== 'promote') throw new Error('promotion fixture missing');
      const { promotedMaturity: _promotedMaturity, ...decision } = value.decision;
      return {
        ...value,
        request: { ...value.request, fromMaturity: 'field_verified', requestedMaturity: 'implemented_local' },
        decision: {
          ...decision,
          fromMaturity: 'field_verified',
          decisionId: 'decision-demote', nonce: 'nonce-demote', decision: 'emergency_demote',
          demotedMaturity: 'implemented_local', reason: 'field incident requires immediate containment',
        },
      };
    });
    const result = await execute({ promotionSource: demotionSource });
    expect(result).toMatchObject({ status: 'applied', effectiveMaturity: 'implemented_local' });
  });

  it('refuses expired and replayed approvals while recording both decisions', async () => {
    const expired = await execute({ now: new Date('2026-08-25T12:21:00.000Z') });
    const applied = await execute();
    const replayed = await execute();
    expect([expired.status, applied.status, replayed.status]).toEqual(['refused', 'applied', 'refused']);
    expect(ledger.read()).toHaveLength(3);
  });

  it('allows exactly one of 32 consumers and keeps a contiguous valid chain', async () => {
    const results = await Promise.all(Array.from({ length: 32 }, async () => await execute()));
    expect(results.filter(({ status }) => status === 'applied')).toHaveLength(1);
    expect(ledger.read()).toHaveLength(32);
    expect(ledger.verify()).toEqual({ ok: true });
  });

  it('returns indeterminate when an unclassified append failure may have persisted', async () => {
    const result = await execute({ ledger: new FailingLedger() });
    expect(result).toEqual({ status: 'indeterminate', reason: 'ledger_commit_unknown' });
  });
});
