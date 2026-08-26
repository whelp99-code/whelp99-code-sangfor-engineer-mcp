import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FilePromotionLedger,
  PromotionLedgerStaleEvidenceError,
  PromotionLedgerUnavailableError,
  capabilityEvidenceManifestSchema,
  capabilityPromotionEnvelopeSchema,
  canonicalizeCapabilityApproval,
  computeEffectiveReplacementCoverage,
  executeCapabilityPromotion,
  loadWorkAtomCatalog,
  nodeEvidenceFilesystem,
  signCapabilityApproval,
  validateAndPersistEvidenceStaleness,
  type EvidenceValidationContext,
} from '../packages/sangfor-competency/src/index.js';
import {
  computeFixtureCoverage,
  createEffectiveFixture,
  requireEffectiveReport,
} from './helpers/effective-maturity-fixture.js';

const APPROVAL_SECRET = 'todo-10-stale-approval-secret-at-least-32';
const fixtures: ReturnType<typeof createEffectiveFixture>[] = [];
const setup = () => {
  const value = createEffectiveFixture();
  fixtures.push(value);
  return value;
};
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.cleanup(); });

function driftContext(value: ReturnType<typeof setup>): EvidenceValidationContext {
  return {
    ...value.fixture.context,
    clock: { now: () => new Date('2026-08-25T12:11:00.000Z') },
    currentDigests: {
      ...value.fixture.context.currentDigests,
      runtimeDigest: value.fixture.context.currentDigests.recipeDigest,
    },
  };
}

function signedEnvelope(
  manifestSource: string,
  decisionId: string,
): string {
  const manifest = capabilityEvidenceManifestSchema.parse(JSON.parse(manifestSource));
  const manifestDigest = createHash('sha256').update(manifestSource).digest('hex');
  const request = {
    version: 1, requestId: `request-${decisionId}`, manifestId: manifest.manifestId, manifestDigest,
    target: manifest.target,
    deviceIdentityDigest: manifest.digests.deviceIdentityDigest, originDigest: manifest.digests.originDigest,
    fromMaturity: 'tested_mock', requestedMaturity: 'field_verified',
    requestedBy: { actorId: 'requester-1', actorType: 'ai_engineer' }, requestedAt: '2026-08-25T12:05:00.000Z',
    evidenceRef: 'manifest.json', auditRef: 'promotion.jsonl', o5Counters: manifest.o5Counters,
  } as const;
  const unsigned = capabilityPromotionEnvelopeSchema.parse({
    version: 1,
    request,
    decision: {
      version: 1, decisionId, requestId: request.requestId, manifestId: manifest.manifestId, manifestDigest,
      target: manifest.target, o5Counters: manifest.o5Counters,
      deviceIdentityDigest: manifest.digests.deviceIdentityDigest, originDigest: manifest.digests.originDigest,
      fromMaturity: 'tested_mock',
      reviewer: { actorId: 'human-reviewer-1', actorType: 'human_pm' }, decidedAt: '2026-08-25T12:10:00.000Z',
      auditRef: 'decision.jsonl', approvalDigest: '0'.repeat(64), nonce: `nonce-${decisionId}`,
      expiresAt: '2026-08-25T12:20:00.000Z', decision: 'promote', promotedMaturity: 'field_verified',
    },
  });
  const decision = unsigned.decision;
  if (decision === null) throw new Error('decision fixture missing');
  const approvalDigest = signCapabilityApproval(APPROVAL_SECRET, canonicalizeCapabilityApproval(unsigned));
  return JSON.stringify({ ...unsigned, decision: { ...decision, approvalDigest } });
}

async function promote(value: ReturnType<typeof setup>, manifestSource: string, decisionId: string) {
  const catalog = loadWorkAtomCatalog(value.context.catalogRoot);
  if (!catalog.ok) throw new Error('catalog fixture unavailable');
  return executeCapabilityPromotion({
    manifestSource,
    promotionSource: signedEnvelope(manifestSource, decisionId),
    grounding: { atoms: catalog.atoms, context: value.context },
    validation: { evidenceRoot: value.claim.evidenceRoot, context: value.fixture.context },
    secret: APPROVAL_SECRET,
    nonceStore: { consume: () => ({ ok: true }) },
    ledger: value.ledger,
    now: new Date('2026-08-25T12:10:00.000Z'),
  });
}

function stalenessInput(value: ReturnType<typeof setup>, context = driftContext(value)) {
  return {
    manifestSource: value.claim.manifestSource,
    manifest: value.fixture.manifest,
    evidenceRoot: value.claim.evidenceRoot,
    filesystem: nodeEvidenceFilesystem(),
    context,
    baseline: 'tested_mock' as const,
    ledger: value.ledger,
  };
}

describe('durable evidence invalidation', () => {
  it('Given persisted drift, When the original active context is replayed, Then the old promotion remains stale', async () => {
    // Given
    const value = setup();
    expect((await promote(value, value.claim.manifestSource, 'initial')).status).toBe('applied');
    const persisted = await validateAndPersistEvidenceStaleness(stalenessInput(value));

    // When
    const replay = requireEffectiveReport(await computeFixtureCoverage(value));

    // Then
    expect(persisted.status).toBe('applied');
    const events = value.ledger.read();
    expect(events.map(({ action }) => action)).toEqual(['promote', 'stale']);
    expect(events[1]).toEqual(expect.objectContaining({
      at: '2026-08-25T12:11:00.000Z',
      target: value.fixture.manifest.target,
      manifestRef: value.manifestRef,
      nonceRef: null,
      invalidation: expect.objectContaining({ reason: 'identity_drift', observedIdentityRef: expect.stringMatching(/^[a-f0-9]{64}$/u) }),
    }));
    expect(replay.replacedAtoms).toBe(0);
    expect(replay.claimIssues).toEqual([expect.objectContaining({ state: 'stale' })]);
  });

  it('Given a stale event, When the same digest is promoted again, Then it is refused before reactivation', async () => {
    // Given
    const value = setup();
    expect((await promote(value, value.claim.manifestSource, 'initial')).status).toBe('applied');
    await validateAndPersistEvidenceStaleness(stalenessInput(value));

    // When
    const replay = await promote(value, value.claim.manifestSource, 'replay');

    // Then
    expect(replay).toMatchObject({ status: 'refused', refusalCode: 'stale_evidence_digest' });
    expect(() => value.ledger.append(value.event({ index: 9, action: 'promote', fromMaturity: 'tested_mock', toMaturity: 'field_verified' }))).toThrow(PromotionLedgerStaleEvidenceError);
  });

  it('Given a stale old digest, When new evidence receives a signed adjacent promotion, Then replacement reactivates', async () => {
    // Given
    const value = setup();
    expect((await promote(value, value.claim.manifestSource, 'initial')).status).toBe('applied');
    await validateAndPersistEvidenceStaleness(stalenessInput(value));
    const newManifest = { ...value.fixture.manifest, manifestId: 'manifest-new-evidence-cycle' };
    const newSource = JSON.stringify(newManifest);

    // When
    const promotion = await promote(value, newSource, 'new-cycle');
    const report = requireEffectiveReport(await computeFixtureCoverage(value, { claims: [{ ...value.claim, manifestSource: newSource }] }));

    // Then
    expect(promotion.status).toBe('applied');
    expect(report.replacedAtoms).toBe(1);
  });

  it('Given unknown stale append acknowledgement or a corrupt checkpoint, When drift is observed, Then coverage is invalid', async () => {
    // Given
    const interrupted = setup();
    expect((await promote(interrupted, interrupted.claim.manifestSource, 'initial')).status).toBe('applied');
    const interruptedLedger = FilePromotionLedger.initialize(
      interrupted.ledgerPath,
      'todo-10-ledger-secret-at-least-32-bytes',
      'todo-10-checkpoint-secret-at-least-32-bytes',
      { afterEventDurable: () => { throw new Error('simulated stale-event acknowledgement loss'); } },
    );
    const corrupt = setup();
    expect((await promote(corrupt, corrupt.claim.manifestSource, 'initial')).status).toBe('applied');
    writeFileSync(`${corrupt.ledgerPath}.head.json`, '{}');

    // When
    const interruptedResult = await computeEffectiveReplacementCoverage(interrupted.context, {
      claims: [{ ...interrupted.claim, context: driftContext(interrupted) }],
      ledger: interruptedLedger,
    });
    const corruptResult = await computeFixtureCoverage(corrupt, { validationContext: driftContext(corrupt) });

    // Then
    expect(interruptedResult).toEqual({ ok: false, violations: [expect.objectContaining({ kind: 'promotionLedgerUnavailable' })] });
    expect(() => FilePromotionLedger.open(
      interrupted.ledgerPath,
      'todo-10-ledger-secret-at-least-32-bytes',
      'todo-10-checkpoint-secret-at-least-32-bytes',
    ).read()).toThrow(PromotionLedgerUnavailableError);
    expect(corruptResult).toEqual({ ok: false, violations: [expect.objectContaining({ kind: 'promotionLedgerUnavailable' })] });
  });
});
