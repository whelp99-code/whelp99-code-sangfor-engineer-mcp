import { createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FilePromotionLedger,
  buildCoverageContext,
  capabilityPromotionEnvelopeSchema,
  canonicalizeCapabilityApproval,
  deriveEffectiveMaturity,
  executeCapabilityPromotion,
  loadMaturityPolicyStrict,
  loadWorkAtomCatalog,
  signCapabilityApproval,
  type CapabilityPromotionEnvelope,
  type PromotionNonceStore,
} from '../packages/sangfor-competency/src/index.js';
import { writeValidationFixture } from './helpers/capability-evidence-validation-fixture.js';

const APPROVAL_SECRET = 'reliability-approval-secret-material-32';
const LEDGER_SECRET = 'reliability-ledger-secret-material-32xx';
const CHECKPOINT_SECRET = 'reliability-checkpoint-secret-material';
const NOW = new Date('2026-08-25T12:10:00.000Z');

class MemoryNonceStore implements PromotionNonceStore {
  private readonly values = new Set<string>();
  consume(nonce: string): { readonly ok: boolean; readonly reason?: string } {
    if (this.values.has(nonce)) return { ok: false, reason: 'approval nonce already used' };
    this.values.add(nonce);
    return { ok: true };
  }
}

describe('capability promotion durability and stale-state gate', () => {
  let root: string;
  let manifestSource: string;
  let fixture: ReturnType<typeof writeValidationFixture>;
  let grounding: Parameters<typeof executeCapabilityPromotion>[0]['grounding'];
  let nonceStore: MemoryNonceStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'promotion-reliability-'));
    fixture = writeValidationFixture(root);
    manifestSource = JSON.stringify(fixture.manifest);
    const groundingRoot = new URL('./fixtures/capability-evidence/grounding/', import.meta.url).pathname;
    const catalog = loadWorkAtomCatalog(groundingRoot);
    const policy = loadMaturityPolicyStrict(groundingRoot);
    if (!catalog.ok || !policy.ok) throw new Error('grounding fixture unavailable');
    grounding = {
      atoms: catalog.atoms,
      context: buildCoverageContext({
        catalogRoot: groundingRoot, evidenceRoot: root,
        registeredTools: ['sangfor_evaluate_config'], maturityPolicy: policy.entries,
      }),
    };
    nonceStore = new MemoryNonceStore();
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function envelope(decisionId: string, nonce: string, fromMaturity = 'tested_mock'): CapabilityPromotionEnvelope {
    const request = {
      version: 1, requestId: `request-${decisionId}`, manifestId: fixture.manifest.manifestId,
      manifestDigest: createHash('sha256').update(manifestSource).digest('hex'), target: fixture.manifest.target,
      deviceIdentityDigest: fixture.manifest.digests.deviceIdentityDigest, originDigest: fixture.manifest.digests.originDigest,
      fromMaturity, requestedMaturity: 'field_verified',
      requestedBy: { actorId: 'requester-1', actorType: 'ai_engineer' }, requestedAt: '2026-08-25T12:05:00.000Z',
      evidenceRef: 'manifest.json', auditRef: 'request.jsonl', o5Counters: fixture.manifest.o5Counters,
    };
    const unsigned = capabilityPromotionEnvelopeSchema.parse({
      version: 1, request,
      decision: {
        version: 1, decisionId, requestId: request.requestId, manifestId: request.manifestId,
        manifestDigest: request.manifestDigest, target: request.target, o5Counters: request.o5Counters,
        deviceIdentityDigest: request.deviceIdentityDigest, originDigest: request.originDigest,
        fromMaturity, reviewer: { actorId: 'human-reviewer-1', actorType: 'human_pm' },
        decidedAt: NOW.toISOString(), auditRef: 'decision.jsonl', approvalDigest: '0'.repeat(64), nonce,
        expiresAt: '2026-08-25T12:20:00.000Z', decision: 'promote', promotedMaturity: 'field_verified',
      },
    });
    const decision = unsigned.decision;
    if (decision === null) throw new Error('decision fixture missing');
    const approvalDigest = signCapabilityApproval(APPROVAL_SECRET, canonicalizeCapabilityApproval(unsigned));
    return capabilityPromotionEnvelopeSchema.parse({ ...unsigned, decision: { ...decision, approvalDigest } });
  }

  function execute(promotion: CapabilityPromotionEnvelope, ledger: FilePromotionLedger) {
    return executeCapabilityPromotion({
      manifestSource, promotionSource: JSON.stringify(promotion), grounding,
      validation: { evidenceRoot: root, context: fixture.context },
      secret: APPROVAL_SECRET, nonceStore, ledger, now: NOW,
    });
  }

  it.each(['afterEventDurable', 'afterCheckpointDurable'] as const)(
    'returns INDETERMINATE without a maturity claim after %s acknowledgement loss',
    async (faultPoint) => {
      const path = join(root, `${faultPoint}.jsonl`);
      const ledger = FilePromotionLedger.initialize(path, LEDGER_SECRET, CHECKPOINT_SECRET, {
        [faultPoint]: () => { throw new Error('simulated acknowledgement loss'); },
      });
      const result = await execute(envelope(`decision-${faultPoint}`, `nonce-${faultPoint}`), ledger);
      expect(result).toMatchObject({ status: 'indeterminate', reason: 'ledger_commit_unknown' });
      expect('effectiveMaturity' in result).toBe(false);
      const restarted = FilePromotionLedger.open(path, LEDGER_SECRET, CHECKPOINT_SECRET);
      if (faultPoint === 'afterEventDurable') expect(() => restarted.read()).toThrow();
      const reconciled = restarted.reconcile();
      expect(deriveEffectiveMaturity('tested_mock', fixture.manifest.target, reconciled)).toBe('field_verified');
    },
  );

  it.each([
    ['missing ledger', (path: string) => unlinkSync(path)],
    ['missing checkpoint', (path: string) => unlinkSync(`${path}.head.json`)],
    ['corrupt ledger JSON', (path: string) => writeFileSync(path, '{\n')],
    ['corrupt checkpoint JSON', (path: string) => writeFileSync(`${path}.head.json`, '{')],
    ['deleted ledger suffix', (path: string) => writeFileSync(path, '')],
    ['extra uncheckpointed tail', (path: string) => appendFileSync(path, readFileSync(path, 'utf8'))],
    ['tampered checkpoint', (path: string) => writeFileSync(
      `${path}.head.json`, readFileSync(`${path}.head.json`, 'utf8').replace('"eventCount":1', '"eventCount":2'),
    )],
  ])('returns no final maturity for %s', async (_name, corrupt) => {
    const path = join(root, 'unavailable.jsonl');
    const ledger = FilePromotionLedger.initialize(path, LEDGER_SECRET, CHECKPOINT_SECRET);
    expect((await execute(envelope('decision-initial', 'nonce-initial'), ledger)).status).toBe('applied');
    corrupt(path);

    const result = await execute(envelope('decision-read', 'nonce-read', 'field_verified'), ledger);

    expect(result).toEqual({ status: 'indeterminate', reason: 'ledger_state_unknown' });
    expect('effectiveMaturity' in result).toBe(false);
  });

  it('returns no final maturity when checkpoint authentication uses the wrong key', async () => {
    const path = join(root, 'wrong-key.jsonl');
    FilePromotionLedger.initialize(path, LEDGER_SECRET, CHECKPOINT_SECRET);
    const wrongKeyLedger = FilePromotionLedger.open(path, LEDGER_SECRET, 'wrong-checkpoint-secret-material-32');

    const result = await execute(envelope('decision-wrong-key', 'nonce-wrong-key'), wrongKeyLedger);

    expect(result).toEqual({ status: 'indeterminate', reason: 'ledger_state_unknown' });
    expect('effectiveMaturity' in result).toBe(false);
  });

  it('allows one of two differently nonced approvals from the same old maturity and rejects the stale one', async () => {
    const ledger = FilePromotionLedger.initialize(join(root, 'race.jsonl'), LEDGER_SECRET, CHECKPOINT_SECRET);
    const results = await Promise.all([
      execute(envelope('decision-a', 'nonce-a'), ledger),
      execute(envelope('decision-b', 'nonce-b'), ledger),
    ]);
    expect(results.filter(({ status }) => status === 'applied')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'refused' && result.refusalCode === 'stale_maturity')).toHaveLength(1);
    expect(deriveEffectiveMaturity('tested_mock', fixture.manifest.target, ledger.read())).toBe('field_verified');
    expect(ledger.read().filter(({ outcome }) => outcome === 'applied')).toHaveLength(1);
  });

  it('binds fromMaturity into the signature and requires it to equal derived state', async () => {
    const ledger = FilePromotionLedger.initialize(join(root, 'from.jsonl'), LEDGER_SECRET, CHECKPOINT_SECRET);
    const validSource = JSON.stringify(envelope('decision-from', 'nonce-from'));
    const mutated = validSource.replaceAll('tested_mock', 'implemented_local');
    const forged = await executeCapabilityPromotion({
      manifestSource, promotionSource: mutated, grounding,
      validation: { evidenceRoot: root, context: fixture.context },
      secret: APPROVAL_SECRET, nonceStore, ledger, now: NOW,
    });
    const stale = await execute(envelope('decision-stale', 'nonce-stale', 'planned'), ledger);
    expect(forged).toMatchObject({ status: 'refused', refusalCode: 'signature_mismatch' });
    expect(stale).toMatchObject({ status: 'refused', refusalCode: 'stale_maturity' });
  });
});
