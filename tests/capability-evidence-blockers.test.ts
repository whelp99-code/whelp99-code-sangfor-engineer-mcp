import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as competency from '../packages/sangfor-competency/src/index.js';
import {
  buildCoverageContext,
  capabilityEvidenceArtifactSchema,
  capabilityEvidenceManifestSchema,
  capabilityEvidenceRunSchema,
  capabilityPromotionDecisionSchema,
  capabilityPromotionEnvelopeSchema,
  loadMaturityPolicyStrict,
  loadWorkAtomCatalog,
  negativeCaseSchema,
  parseGroundedCapabilityEvidence,
} from '../packages/sangfor-competency/src/index.js';

const manifest = capabilityEvidenceManifestSchema.parse(JSON.parse(readFileSync(
  new URL('./fixtures/capability-evidence/valid-manifest.json', import.meta.url),
  'utf8',
)));
const promotion = capabilityPromotionEnvelopeSchema.parse(JSON.parse(readFileSync(
  new URL('./fixtures/capability-evidence/valid-promotion-envelope.json', import.meta.url),
  'utf8',
)));
const run = capabilityEvidenceRunSchema.parse(manifest.runs[0]);
const artifact = capabilityEvidenceArtifactSchema.parse(manifest.artifacts[0]);
const negativeCase = negativeCaseSchema.parse(manifest.negativeCases[0]);
const decision = capabilityPromotionDecisionSchema.parse(promotion.decision);
const groundingRoot = fileURLToPath(new URL('./fixtures/capability-evidence/grounding', import.meta.url));
const catalog = loadWorkAtomCatalog(groundingRoot);
const policy = loadMaturityPolicyStrict(groundingRoot);
if (!catalog.ok || !policy.ok) throw new Error('Todo 2 grounding fixtures must load');
const grounding = {
  atoms: catalog.atoms,
  context: buildCoverageContext({
    catalogRoot: groundingRoot,
    evidenceRoot: process.cwd(),
    registeredTools: ['sangfor_evaluate_config', 'sangfor_check_version'],
    maturityPolicy: policy.entries,
  }),
};

describe('Todo 7 independent verifier blockers', () => {
  it('exposes authoritative grounded evidence and promotion parse seams', () => {
    // Given
    const seams = ['parseGroundedCapabilityEvidence', 'parseGroundedCapabilityPromotion'];

    // When
    const exported = seams.map((seam) => seam in competency);

    // Then
    expect(exported).toEqual([true, true]);
  });

  it('grounds the valid fixture in the real WorkAtom catalog, policy, and registered tool context', () => {
    // Given
    const source = JSON.stringify(manifest);

    // When
    const parsed = parseGroundedCapabilityEvidence({ source, grounding });

    // Then
    expect(parsed.target.workAtomIds).toEqual(['op_daily_health']);
  });

  it('refuses invented and mismatched WorkAtom, capability, product, and tool references', () => {
    // Given
    const targets = [
      { ...manifest.target, workAtomIds: ['invented_atom'] },
      { ...manifest.target, capabilityId: 'invented_capability' },
      { ...manifest.target, capabilityId: 'volume_create' },
      { ...manifest.target, toolId: 'invented_tool' },
      { ...manifest.target, productId: 'IAG', capabilityId: 'auth_source', workAtomIds: ['deploy_cluster_init'] },
    ];

    // When
    const actions = targets.map((target) => () => parseGroundedCapabilityEvidence({
      source: JSON.stringify({ ...manifest, target }),
      grounding,
    }));

    // Then
    actions.forEach((action) => expect(action).toThrow(/CAPABILITY_EVIDENCE_GROUNDING_REFUSED/u));
  });

  it('refuses a human-only catalog atom even when caller data omits its true automatability', () => {
    // Given
    const target = { ...manifest.target, workAtomIds: ['pm_signoff'] };

    // When
    const action = (): unknown => parseGroundedCapabilityEvidence({
      source: JSON.stringify({ ...manifest, target }),
      grounding,
    });

    // Then
    expect(action).toThrow(/human_only_atom/u);
  });

  it('rejects contradictory PASS restoration and unsafe mutation counts', () => {
    // Given
    const contradictory = {
      ...manifest,
      runs: [{
        ...run,
        postRunState: { mode: 'restored', result: 'fail', readBackArtifactId: 'artifact-restore' },
        mutationCount: 1,
        retryCount: 3,
        collateralMutationCount: 2,
      }],
      o5Counters: { ...manifest.o5Counters, retryCount: 3, collateralMutationCount: 2 },
    };

    // When
    const result = capabilityEvidenceManifestSchema.safeParse(contradictory);

    // Then
    expect(result.success).toBe(false);
  });

  it('rejects read-back PASS that reuses a generic run artifact', () => {
    // Given
    const reusedArtifact = {
      ...manifest,
      runs: [{
        ...run,
        independentReadBack: { ...run.independentReadBack, artifactId: 'artifact-run' },
      }],
    };

    // When
    const result = capabilityEvidenceManifestSchema.safeParse(reusedArtifact);

    // Then
    expect(result.success).toBe(false);
  });

  it('rejects duplicate negative case codes even when record IDs differ', () => {
    // Given
    const duplicateType = {
      ...manifest,
      negativeCases: [negativeCase, { ...negativeCase, id: 'negative-002' }],
      o5Counters: { ...manifest.o5Counters, negativeCasePassCount: 2 },
    };

    // When
    const result = capabilityEvidenceManifestSchema.safeParse(duplicateType);

    // Then
    expect(result.success).toBe(false);
  });

  it('rejects read-back before completion and generation before observation', () => {
    // Given
    const invalidOrder = {
      ...manifest,
      generatedAt: '2026-08-25T11:07:00.000Z',
      runs: [{
        ...run,
        independentReadBack: { ...run.independentReadBack, observedAt: '2026-08-25T10:59:00.000Z' },
      }],
    };

    const artifactBeforeRun = {
      ...manifest,
      artifacts: [{ ...artifact, createdAt: '2026-08-25T10:59:00.000Z' }, ...manifest.artifacts.slice(1)],
    };
    const eventAfterCompletion = {
      ...manifest,
      negativeCases: [{ ...negativeCase, testedAt: '2026-08-25T11:07:00.000Z' }],
    };

    // When
    const results = [invalidOrder, artifactBeforeRun, eventAfterCompletion]
      .map((value) => capabilityEvidenceManifestSchema.safeParse(value));

    // Then
    expect(results.every((result) => !result.success)).toBe(true);
  });

  it('rejects promotion decisions before requests and reviewer-requester collisions', () => {
    // Given
    const invalidDecision = {
      ...promotion,
      decision: {
        ...decision,
        reviewer: { actorId: promotion.request.requestedBy.actorId, actorType: 'human_pm' },
        decidedAt: '2026-08-25T12:04:00.000Z',
      },
    };

    // When
    const result = capabilityPromotionEnvelopeSchema.safeParse(invalidDecision);

    // Then
    expect(result.success).toBe(false);
  });

  it('rejects a 100000-entry WorkAtom array and a non-NFC artifact path', () => {
    // Given
    const oversized = {
      ...manifest,
      target: { ...manifest.target, workAtomIds: Array.from({ length: 100_000 }, (_, index) => `atom-${index}`) },
    };
    const nonNfc = {
      ...manifest,
      artifacts: [{ ...manifest.artifacts[0], path: 'runs/cafe\u0301.json' }, ...manifest.artifacts.slice(1)],
    };

    // When
    const oversizedResult = capabilityEvidenceManifestSchema.safeParse(oversized);
    const nonNfcResult = capabilityEvidenceManifestSchema.safeParse(nonNfc);

    // Then
    expect(oversizedResult.success).toBe(false);
    expect(nonNfcResult.success).toBe(false);
  });
});
