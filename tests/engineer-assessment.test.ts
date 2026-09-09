import { describe, expect, it } from 'vitest';
import { applyRequirementRevision, assessEngineerCase, assembleEngineerCase } from '../packages/sangfor-planner/src/index.js';
import { assertEngineerAssessmentScope } from '../packages/sangfor-config-state/src/index.js';
import {
  assessHciCapacityOrHaFromInventory,
  collectRequiredObservations,
  summarizeHciHealth,
} from '../packages/sangfor-hci-client/src/index.js';
import { evaluateEngineerFormula } from '../packages/sangfor-sizing/src/index.js';
import {
  evaluateDerivedFitness,
  evaluateEngineerRequirementCompare,
  evaluateSpec,
} from '../packages/sangfor-spec/src/index.js';
import {
  ENGINEER_CASE_SCHEMA_VERSION,
  type EngineerAssessment,
  type EngineerCaseDocument,
  type EngineerObservation,
} from '../packages/shared/src/engineer-case-contract.js';

const AUTH = { tenantId: 'tenant-a', projectId: 'proj-a', actorId: 'actor-a' } as const;
const DIGEST = 'ab'.repeat(32);
const WHEN = '2026-09-09T00:00:00.000Z';
const LATER = '2026-09-10T00:00:00.000Z';

const LIVE_PROVENANCE = {
  transport: 'api' as const,
  endpoint: 'GET /volumes/detail',
  mapperVersion: '1.0.0',
  collectedAt: WHEN,
  collector: 'hci-inventory',
  firmwareVersion: '6.7.0',
};

function observation(partial: EngineerObservation): EngineerObservation {
  return partial;
}

function validFixtureCase(overrides: Record<string, unknown> = {}): EngineerCaseDocument {
  return {
    schemaVersion: ENGINEER_CASE_SCHEMA_VERSION,
    caseId: 'case-existing-1',
    mode: 'existing',
    product: 'HCI_SCP',
    firmware: '6.7.0',
    revision: 'rev-1',
    progress: 'draft',
    environmentKind: 'fixture',
    synthetic: true,
    originalPresent: false,
    observations: [
      observation({
        id: 'obs-total',
        sourceKind: 'provided',
        collectionStatus: 'complete',
        collectedAt: WHEN,
        evidenceRef: 'ev-1',
        value: { presence: 'known', data: { kind: 'number', number: 100, unit: 'GiB' } },
      }),
      observation({
        id: 'obs-used',
        sourceKind: 'provided',
        collectionStatus: 'complete',
        collectedAt: WHEN,
        evidenceRef: 'ev-1',
        value: { presence: 'known', data: { kind: 'number', number: 40, unit: 'GiB' } },
      }),
      observation({
        id: 'obs-ha_status',
        sourceKind: 'provided',
        collectionStatus: 'complete',
        collectedAt: WHEN,
        value: { presence: 'known', data: { kind: 'boolean', boolean: true } },
      }),
      observation({
        id: 'obs-volumes',
        sourceKind: 'provided',
        collectionStatus: 'complete',
        collectedAt: WHEN,
        value: { presence: 'known', data: { kind: 'integer', integer: 3, unit: 'count' } },
      }),
    ],
    requirements: [
      {
        id: 'req-remaining',
        sourceKind: 'provided',
        sourceRef: 'excel-row-1',
        target: 'Usable remaining',
        constraint: 'remaining >= 20 GiB',
        priority: 'high',
        confirmationState: 'confirmed',
        acceptanceCriterion: 'remaining >= 20 GiB',
        revision: 'req-rev-1',
      },
      {
        id: 'req-ha',
        sourceKind: 'provided',
        sourceRef: 'excel-row-2',
        target: 'HA',
        constraint: 'HA enabled',
        priority: 'high',
        confirmationState: 'confirmed',
        acceptanceCriterion: 'HA enabled',
        revision: 'req-rev-1',
      },
      {
        id: 'req-cpu',
        sourceKind: 'provided',
        sourceRef: 'excel-row-3',
        target: 'Host CPU',
        constraint: 'host cpu >= 16 cores',
        priority: 'medium',
        confirmationState: 'confirmed',
        acceptanceCriterion: 'host cpu >= 16 cores',
        revision: 'req-rev-1',
      },
    ],
    calculations: [],
    assessments: [],
    guide: {
      revision: 'guide-rev-1',
      digest: DIGEST,
      requirementRefs: ['req-remaining', 'req-ha', 'req-cpu'],
      steps: [],
      prerequisites: [],
      unresolved: ['assessment not yet computed'],
      readiness: 'review_ready',
    },
    evidence: [{
      id: 'ev-1',
      digest: DIGEST,
      mediaType: 'application/json',
      sanitized: true,
      retention: 'case-revision',
    }],
    execution: { result: 'not_started' },
    ...overrides,
  } as EngineerCaseDocument;
}

function inventory() {
  return {
    volumes: [{ id: 'vol-1', name: 'data', status: 'available', size: 100, description: null }],
    servers: [{ id: 'srv-1' }],
    images: [],
    collection: {
      volumes: { status: 'complete' as const },
      servers: { status: 'complete' as const },
      images: { status: 'complete' as const },
    },
    collectedAt: WHEN,
  };
}

describe('engineer assessment compare (E06)', () => {
  it('assesses every current requirement and traces evidence and formula inputs', () => {
    const required = collectRequiredObservations({
      providedFields: {
        ha_status: { presence: 'known', data: { kind: 'boolean', boolean: true } },
      },
    });
    const result = assessEngineerCase({
      document: validFixtureCase(),
      auth: AUTH,
      caseRevision: 'rev-1',
      now: WHEN,
      requiredObservations: required,
      bindings: [{
        requirementId: 'req-remaining',
        formulaId: 'confirmed-remaining-capacity',
        formulaRoles: { total: 'obs-total', used: 'obs-used' },
        fitnessBaseline: { source: 'HCI sizing table 4', op: 'gte', threshold: 20, unit: 'GiB' },
      }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.guideReadyGranted).toBe(false);
    expect(result.assembled.ok).toBe(true);
    if (result.assembled.ok) {
      expect(result.assembled.guideReadyGranted).toBe(false);
      expect(result.assembled.value.guide.readiness).not.toBe('review_ready');
    }
    expect(result.coverage.requiredCount).toBe(3);
    expect(result.coverage.assessedCount).toBe(3);
    expect(result.coverage.trackingRate).toBe(1);
    expect(result.assessments.map((item) => item.requirementRef).sort()).toEqual(['req-cpu', 'req-ha', 'req-remaining']);
    expect(result.assessments.find((item) => item.requirementRef === 'req-remaining')).toMatchObject({
      status: 'satisfied',
      nextAction: 'none',
    });
    const remaining = result.assessments.find((item) => item.requirementRef === 'req-remaining');
    expect(remaining?.reasons.join(' ')).toMatch(/formula:confirmed-remaining-capacity:1.0.0:inputs=obs-total,obs-used/);
    expect(remaining?.reasons.join(' ')).toMatch(/evidenceRef:ev-1|fitness:CONFIRMED_PASS/);
    expect(remaining?.calculationRefs.length).toBeGreaterThan(0);
    expect(result.assessments.find((item) => item.requirementRef === 'req-ha')?.status).toBe('satisfied');
    expect(result.assessments.find((item) => item.requirementRef === 'req-cpu')?.status).toBe('unresolved');
    expect(result.productMaturity.scope).toBe('not-this-case-coverage');
    expect(result.productMaturity.automaticHostNetworkHaCollection).toBe('unsupported');
    expect(result.productMaturity.fieldAcceptanceBlockersResolved).toBe(false);
  });

  it('does not treat document search as a current-device PASS', () => {
    const document = validFixtureCase({
      observations: [],
      requirements: [validFixtureCase().requirements[1]],
    });
    const result = assessEngineerCase({
      document,
      auth: AUTH,
      caseRevision: 'rev-1',
      searchCitations: [{ requirementId: 'req-ha', source: 'KB article: cluster HA is healthy' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.assessments[0]).toMatchObject({
      requirementRef: 'req-ha',
      status: 'unresolved',
    });
    expect(result.assessments[0]?.reasons.join(' ')).toMatch(/DOCUMENT_SEARCH|문서 검색/);
    expect(result.guideReadyGranted).toBe(false);
  });

  it('refuses wrong product or firmware instead of granting satisfied', () => {
    const wrongProduct = assessEngineerCase({
      document: validFixtureCase(),
      auth: AUTH,
      caseRevision: 'rev-1',
      expectedProduct: 'IAG',
    });
    expect(wrongProduct).toMatchObject({ ok: false, code: 'WRONG_PRODUCT', guideReadyGranted: false });

    const wrongFirmware = assessEngineerCase({
      document: validFixtureCase(),
      auth: AUTH,
      caseRevision: 'rev-1',
      expectedFirmware: '9.9.9',
    });
    expect(wrongFirmware).toMatchObject({ ok: false, code: 'WRONG_FIRMWARE', guideReadyGranted: false });

    const liveObs = observation({
      id: 'obs-volumes',
      sourceKind: 'observed',
      collectionStatus: 'complete',
      collectedAt: WHEN,
      value: { presence: 'known', data: { kind: 'integer', integer: 1, unit: 'count' } },
      factProvenance: { ...LIVE_PROVENANCE, firmwareVersion: '5.0.0' },
    });
    const mixedFirmware = assessEngineerCase({
      document: validFixtureCase({
        environmentKind: 'live',
        originalPresent: true,
        synthetic: false,
        observations: [liveObs],
        requirements: [validFixtureCase().requirements[1]],
      }),
      auth: AUTH,
      caseRevision: 'rev-1',
    });
    expect(mixedFirmware).toMatchObject({ ok: false, code: 'WRONG_FIRMWARE', guideReadyGranted: false });
  });

  it('keeps stale, missing, and conflicting observations unresolved', () => {
    const staleDoc = validFixtureCase({
      observations: [
        observation({
          id: 'obs-ha_status',
          sourceKind: 'provided',
          collectionStatus: 'complete',
          collectedAt: WHEN,
          freshnessPolicy: { maxAgeSec: 60 },
          value: { presence: 'known', data: { kind: 'boolean', boolean: true } },
        }),
      ],
      requirements: [validFixtureCase().requirements[1]],
    });
    const stale = assessEngineerCase({
      document: staleDoc,
      auth: AUTH,
      caseRevision: 'rev-1',
      now: LATER,
    });
    expect(stale.ok).toBe(true);
    if (!stale.ok) throw new Error(stale.message);
    expect(stale.assessments[0]).toMatchObject({ status: 'unresolved', nextAction: 'recollect' });
    expect(stale.assessments[0]?.reasons.join(' ')).toMatch(/STALE_INPUT/);

    const missing = assessEngineerCase({
      document: validFixtureCase({
        observations: [],
        requirements: [validFixtureCase().requirements[2]],
      }),
      auth: AUTH,
      caseRevision: 'rev-1',
      requiredObservations: collectRequiredObservations(),
    });
    expect(missing.ok).toBe(true);
    if (!missing.ok) throw new Error(missing.message);
    expect(missing.assessments[0]).toMatchObject({ status: 'unresolved' });
    expect(missing.assessments[0]?.status).not.toBe('not_applicable');
    expect(missing.assessments[0]?.reasons.join(' ')).toMatch(/E03B_UNSUPPORTED|MISSING_CURRENT|NO_OFFICIAL_HOST_CPU/);

    const conflict = assessEngineerCase({
      document: validFixtureCase({
        observations: [
          observation({
            id: 'obs-ha_status',
            sourceKind: 'provided',
            collectionStatus: 'complete',
            collectedAt: WHEN,
            value: { presence: 'known', data: { kind: 'boolean', boolean: true } },
          }),
          observation({
            id: 'obs-ha_status-alt',
            sourceKind: 'provided',
            collectionStatus: 'complete',
            collectedAt: WHEN,
            value: { presence: 'known', data: { kind: 'boolean', boolean: false } },
          }),
        ],
        requirements: [validFixtureCase().requirements[1]],
      }),
      auth: AUTH,
      caseRevision: 'rev-1',
      bindings: [{ requirementId: 'req-ha', currentRefs: ['obs-ha_status', 'obs-ha_status-alt'] }],
    });
    expect(conflict.ok).toBe(true);
    if (!conflict.ok) throw new Error(conflict.message);
    expect(conflict.assessments[0]).toMatchObject({ status: 'unresolved', nextAction: 'design_decision' });
    expect(conflict.assessments[0]?.reasons.join(' ')).toMatch(/CONFLICTING_OBSERVATION/);
  });

  it('does not hide cannot-confirm as not_applicable', () => {
    const result = assessEngineerCase({
      document: validFixtureCase({
        observations: [],
        requirements: [{
          id: 'req-unknown',
          sourceKind: 'unknown',
          sourceRef: 'excel-row-9',
          priority: 'low',
          confirmationState: 'unconfirmed',
          acceptanceCriterion: 'unspecified; do not default',
          revision: 'req-rev-1',
        }],
      }),
      auth: AUTH,
      caseRevision: 'rev-1',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.assessments[0]?.status).toBe('unresolved');
    expect(result.assessments[0]?.status).not.toBe('not_applicable');

    const explicit = assessEngineerCase({
      document: validFixtureCase({
        requirements: [{
          id: 'req-na',
          sourceKind: 'provided',
          sourceRef: 'excel-row-10',
          constraint: 'not applicable',
          priority: 'low',
          confirmationState: 'rejected',
          acceptanceCriterion: 'not applicable',
          revision: 'req-rev-1',
        }],
      }),
      auth: AUTH,
      caseRevision: 'rev-1',
      bindings: [{
        requirementId: 'req-na',
        explicitlyNotApplicable: true,
        notApplicableReason: 'customer excluded this item from the case',
      }],
    });
    expect(explicit.ok).toBe(true);
    if (!explicit.ok) throw new Error(explicit.message);
    expect(explicit.assessments[0]?.status).toBe('not_applicable');
  });

  it('refuses mixing revisions of the same case', () => {
    expect(assessEngineerCase({
      document: validFixtureCase(),
      auth: AUTH,
      caseRevision: 'rev-2',
    })).toMatchObject({ ok: false, code: 'MIXED_CASE_REVISION', guideReadyGranted: false });

    expect(assessEngineerCase({
      document: validFixtureCase(),
      auth: AUTH,
      caseRevision: 'rev-1',
      companionRevisions: ['rev-1', 'rev-2'],
    })).toMatchObject({ ok: false, code: 'MIXED_CASE_REVISION', guideReadyGranted: false });

    expect(assertEngineerAssessmentScope({
      document: validFixtureCase(),
      caseRevision: 'rev-1',
      companionRevisions: ['rev-other'],
      projectId: AUTH.projectId,
    })).toMatchObject({ ok: false, code: 'MIXED_CASE_REVISION', guideReadyGranted: false });
  });

  it('refuses reusing a deleted requirement assessment as current', () => {
    const baseline = validFixtureCase({
      assessments: [{
        id: 'assess-req-ha',
        requirementRef: 'req-ha',
        calculationRefs: [],
        status: 'satisfied',
        reasons: ['old satisfied row'],
        nextAction: 'none',
      }] satisfies EngineerAssessment[],
    });
    const afterDelete = applyRequirementRevision(baseline, baseline.requirements.filter((item) => item.id !== 'req-ha'));
    expect(afterDelete.document.assessments).toEqual([]);
    const reused = assessEngineerCase({
      document: afterDelete.document,
      auth: AUTH,
      caseRevision: 'rev-1',
      priorAssessments: baseline.assessments,
    });
    expect(reused).toMatchObject({
      ok: false,
      code: 'DELETED_REQUIREMENT_REUSED',
      guideReadyGranted: false,
    });
  });

  it('does not use volume-status health or inventory counts as capacity/HA PASS', () => {
    const health = summarizeHciHealth(inventory());
    expect(health.verdict).toBe('PASS');
    expect(health.scope).toBe('volume-status');
    expect(assessHciCapacityOrHaFromInventory(inventory())).toMatchObject({
      verdict: 'INDETERMINATE',
      scope: 'capacity-or-ha',
      guideReadyGranted: false,
    });

    const result = assessEngineerCase({
      document: validFixtureCase({
        observations: [validFixtureCase().observations[3]],
        requirements: [validFixtureCase().requirements[1]],
      }),
      auth: AUTH,
      caseRevision: 'rev-1',
      inventory: inventory(),
      hciHealthVerdict: health.verdict,
      bindings: [{ requirementId: 'req-ha', currentRef: 'obs-volumes', fieldId: 'ha_status' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.assessments[0]?.status).toBe('unresolved');
    expect(result.assessments[0]?.reasons.join(' ')).toMatch(/SNAPSHOT_NOT_CAPABILITY_ROW/);
    expect(result.guideReadyGranted).toBe(false);
  });

  it('uses evaluateEngineerFormula and evaluateDerivedFitness, and keeps INDETERMINATE from becoming satisfied', () => {
    const remaining = evaluateEngineerFormula({
      id: 'calc-remaining',
      formulaId: 'confirmed-remaining-capacity',
      roles: {
        total: {
          id: 'obs-total',
          sourceKind: 'provided',
          collectionStatus: 'complete',
          value: { presence: 'known', data: { kind: 'number', number: 100, unit: 'GiB' } },
        },
        used: {
          id: 'obs-used',
          sourceKind: 'provided',
          collectionStatus: 'complete',
          value: { presence: 'known', data: { kind: 'number', number: 40, unit: 'GiB' } },
        },
      },
    });
    expect(remaining.result).toEqual({ presence: 'known', data: { kind: 'number', number: 60, unit: 'GiB' } });
    expect(evaluateDerivedFitness({ calculation: remaining }).verdict).toBe('INDETERMINATE');

    const noBaseline = assessEngineerCase({
      document: validFixtureCase({
        requirements: [validFixtureCase().requirements[0]],
      }),
      auth: AUTH,
      caseRevision: 'rev-1',
      bindings: [{
        requirementId: 'req-remaining',
        formulaId: 'confirmed-remaining-capacity',
        formulaRoles: { total: 'obs-total', used: 'obs-used' },
      }],
    });
    expect(noBaseline.ok).toBe(true);
    if (!noBaseline.ok) throw new Error(noBaseline.message);
    expect(noBaseline.assessments[0]?.status).toBe('unresolved');

    const gap = assessEngineerCase({
      document: validFixtureCase({
        observations: [
          observation({
            id: 'obs-total',
            sourceKind: 'provided',
            collectionStatus: 'complete',
            collectedAt: WHEN,
            value: { presence: 'known', data: { kind: 'number', number: 100, unit: 'GiB' } },
          }),
          observation({
            id: 'obs-used',
            sourceKind: 'provided',
            collectionStatus: 'complete',
            collectedAt: WHEN,
            value: { presence: 'known', data: { kind: 'number', number: 90, unit: 'GiB' } },
          }),
        ],
        requirements: [validFixtureCase().requirements[0]],
      }),
      auth: AUTH,
      caseRevision: 'rev-1',
      bindings: [{
        requirementId: 'req-remaining',
        formulaId: 'confirmed-remaining-capacity',
        formulaRoles: { total: 'obs-total', used: 'obs-used' },
        fitnessBaseline: { source: 'HCI sizing table 4', op: 'gte', threshold: 20, unit: 'GiB' },
      }],
    });
    expect(gap.ok).toBe(true);
    if (!gap.ok) throw new Error(gap.message);
    expect(gap.assessments[0]).toMatchObject({ status: 'change_needed', nextAction: 'config_change' });

    const indeterminate = evaluateEngineerRequirementCompare({
      current: { presence: 'known', data: { kind: 'string', text: 'healthy' } },
      desired: { kind: 'numeric', op: 'gte', threshold: 20, unit: 'GiB' },
    });
    expect(indeterminate.verdict).toBe('INDETERMINATE');
    expect(indeterminate.status).toBe('unresolved');
    expect(indeterminate.guideReadyGranted).toBe(false);
  });

  it('refuses live observed without originalPresent / bindObservedFactToCase', () => {
    const unbound = assessEngineerCase({
      document: validFixtureCase({
        environmentKind: 'live',
        originalPresent: false,
        observations: [observation({
          id: 'obs-volumes',
          sourceKind: 'observed',
          collectionStatus: 'complete',
          collectedAt: WHEN,
          value: { presence: 'known', data: { kind: 'integer', integer: 1, unit: 'count' } },
          factProvenance: LIVE_PROVENANCE,
        })],
      }),
      auth: AUTH,
      caseRevision: 'rev-1',
    });
    expect(unbound).toMatchObject({ ok: false, code: 'LIVE_OBSERVED_UNBOUND', guideReadyGranted: false });
  });

  it('keeps evaluateSpec INDETERMINATE from becoming an engineer PASS', () => {
    const specResult = evaluateSpec({
      id: 'ha-fit',
      product: 'HCI',
      items: [{
        id: 'ha',
        capabilityId: 'ha',
        label: 'HA',
        observedKey: 'ha',
        op: 'eq',
        expected: true,
        severity: 'must',
      }],
    }, {});
    expect(specResult.items[0]?.verdict).toBe('INDETERMINATE');
    expect(specResult.ok).toBe(false);
  });
});
