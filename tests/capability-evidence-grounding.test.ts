import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildCoverageContext,
  capabilityEvidenceManifestSchema,
  capabilityEvidenceRunSchema,
  capabilityPromotionDecisionSchema,
  capabilityPromotionEnvelopeSchema,
  loadMaturityPolicyStrict,
  loadWorkAtomCatalog,
  parseGroundedCapabilityPromotion,
} from '../packages/sangfor-competency/src/index.js';

const manifestSource = readFileSync(new URL('./fixtures/capability-evidence/valid-manifest.json', import.meta.url), 'utf8');
const promotionSource = readFileSync(new URL('./fixtures/capability-evidence/valid-promotion-envelope.json', import.meta.url), 'utf8');
const manifest = capabilityEvidenceManifestSchema.parse(JSON.parse(manifestSource));
const promotion = capabilityPromotionEnvelopeSchema.parse(JSON.parse(promotionSource));
const decision = capabilityPromotionDecisionSchema.parse(promotion.decision);
const run = capabilityEvidenceRunSchema.parse(manifest.runs[0]);
const groundingRoot = fileURLToPath(new URL('./fixtures/capability-evidence/grounding', import.meta.url));
const catalog = loadWorkAtomCatalog(groundingRoot);
const policy = loadMaturityPolicyStrict(groundingRoot);
if (!catalog.ok || !policy.ok) throw new Error('Todo 2 grounding fixtures must load');
const grounding = {
  atoms: catalog.atoms,
  context: buildCoverageContext({
    catalogRoot: groundingRoot,
    evidenceRoot: process.cwd(),
    registeredTools: ['sangfor_evaluate_config'],
    maturityPolicy: policy.entries,
  }),
};
const manifestDigest = createHash('sha256').update(manifestSource).digest('hex');
const validPromotion = {
  ...promotion,
  request: { ...promotion.request, manifestDigest },
  decision: { ...decision, manifestDigest },
};

describe('grounded capability promotion', () => {
  it('accepts exact manifest bytes, target, counters, chronology, and separated roles', () => {
    // Given
    const source = promotionSource;

    // When
    const parsed = parseGroundedCapabilityPromotion({ manifestSource, promotionSource: source, grounding });

    // Then
    expect(parsed.request.manifestDigest).toBe(manifestDigest);
  });

  it('rejects a promotion rebound to a different manifest digest or target', () => {
    // Given
    const wrongDigest = {
      ...validPromotion,
      request: { ...validPromotion.request, manifestDigest: '0'.repeat(64) },
      decision: { ...validPromotion.decision, manifestDigest: '0'.repeat(64) },
    };
    const inventedTarget = { ...manifest.target, capabilityId: 'invented_capability' };
    const wrongTarget = {
      ...validPromotion,
      request: { ...validPromotion.request, target: inventedTarget },
      decision: { ...validPromotion.decision, target: inventedTarget },
    };

    // When
    const actions = [wrongDigest, wrongTarget].map((value) => () => parseGroundedCapabilityPromotion({
      manifestSource,
      promotionSource: JSON.stringify(value),
      grounding,
    }));

    // Then
    actions.forEach((action) => expect(action).toThrow(/CAPABILITY_EVIDENCE_GROUNDING_REFUSED/u));
  });

  it('rejects a promotion rebound to different device or origin digests', () => {
    const rebound = {
      ...validPromotion,
      request: { ...validPromotion.request, deviceIdentityDigest: '1'.repeat(64), originDigest: '2'.repeat(64) },
      decision: { ...validPromotion.decision, deviceIdentityDigest: '1'.repeat(64), originDigest: '2'.repeat(64) },
    };

    expect(() => parseGroundedCapabilityPromotion({
      manifestSource,
      promotionSource: JSON.stringify(rebound),
      grounding,
    })).toThrow(/scope_digest_mismatch/u);
  });

  it('rejects caller counters and promotion chronology that differ from the manifest', () => {
    // Given
    const staleCounters = { ...manifest.o5Counters, passCount: 0 };
    const stale = {
      ...validPromotion,
      request: { ...validPromotion.request, o5Counters: staleCounters },
      decision: { ...validPromotion.decision, o5Counters: staleCounters },
    };
    const early = {
      ...validPromotion,
      request: { ...validPromotion.request, requestedAt: '2026-08-25T11:59:00.000Z' },
      decision: { ...validPromotion.decision, decidedAt: '2026-08-25T12:00:00.000Z' },
    };

    // When
    const actions = [stale, early].map((value) => () => parseGroundedCapabilityPromotion({
      manifestSource,
      promotionSource: JSON.stringify(value),
      grounding,
    }));

    // Then
    actions.forEach((action) => expect(action).toThrow(/CAPABILITY_EVIDENCE_GROUNDING_REFUSED/u));
  });

  it('rejects requester, executor, independent reader, and reviewer role collisions', () => {
    // Given
    const executorId = run.executor.actorId;
    const readerId = run.independentReadBack.verifier.actorId;
    const collided = {
      ...validPromotion,
      request: { ...validPromotion.request, requestedBy: { actorId: executorId, actorType: 'human_pm' } },
      decision: { ...validPromotion.decision, reviewer: { actorId: readerId, actorType: 'human_pm' } },
    };

    // When
    const action = (): unknown => parseGroundedCapabilityPromotion({
      manifestSource,
      promotionSource: JSON.stringify(collided),
      grounding,
    });

    // Then
    expect(action).toThrow(/CAPABILITY_EVIDENCE_GROUNDING_REFUSED/u);
  });
});
