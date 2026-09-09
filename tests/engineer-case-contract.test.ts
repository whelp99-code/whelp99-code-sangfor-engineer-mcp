import { describe, expect, it } from 'vitest';
import {
  MAPPER_VERSION,
  bindObservedFactToCase,
  type FactProvenance,
} from '../packages/sangfor-config-state/src/provenance.js';
import {
  ENGINEER_CASE_SCHEMA_POLICY,
  ENGINEER_CASE_SCHEMA_VERSION,
  serializeEngineerValue,
  type EngineerCaseDocument,
} from '../packages/shared/src/engineer-case-contract.js';
import { assembleEngineerCase } from '../packages/sangfor-planner/src/engineer-case.js';

const AUTH = { tenantId: 'tenant-a', projectId: 'proj-a', actorId: 'actor-a' } as const;
const DIGEST = 'ab'.repeat(32);
const WHEN = '2026-09-09T00:00:00.000Z';

const LIVE_PROVENANCE: FactProvenance = {
  transport: 'api',
  endpoint: 'GET /volumes/detail',
  mapperVersion: MAPPER_VERSION,
  collectedAt: WHEN,
  collector: 'hci-inventory',
};

function validFixtureCase(overrides: Record<string, unknown> = {}): EngineerCaseDocument {
  return {
    schemaVersion: ENGINEER_CASE_SCHEMA_VERSION,
    caseId: 'case-existing-1',
    mode: 'existing',
    product: 'HCI_SCP',
    revision: 'rev-1',
    progress: 'draft',
    environmentKind: 'fixture',
    synthetic: true,
    originalPresent: false,
    observations: [{
      id: 'obs-usable',
      sourceKind: 'provided',
      collectionStatus: 'complete',
      collectedAt: WHEN,
      value: { presence: 'known', data: { kind: 'number', number: 40, unit: 'TiB' } },
    }],
    requirements: [{
      id: 'req-headroom',
      sourceKind: 'provided',
      sourceRef: 'excel-row-1',
      constraint: 'headroom >= 20 percent',
      priority: 'high',
      confirmationState: 'unconfirmed',
      acceptanceCriterion: 'usable headroom remains above 20 percent',
      revision: 'req-rev-1',
    }],
    calculations: [{
      id: 'calc-headroom',
      sourceKind: 'derived',
      formulaId: 'usable-headroom-ratio',
      formulaVersion: '1.0.0',
      inputRefs: ['obs-usable'],
      assumptions: ['usable capacity is the provided fixture value'],
      result: { presence: 'known', data: { kind: 'number', number: 0, unit: 'percent' } },
    }],
    assessments: [{
      id: 'assess-headroom',
      requirementRef: 'req-headroom',
      currentRef: 'obs-usable',
      calculationRefs: ['calc-headroom'],
      status: 'unresolved',
      reasons: ['usable capacity is provided, not observed'],
      nextAction: 'recollect',
    }],
    guide: {
      revision: 'guide-rev-1',
      digest: DIGEST,
      requirementRefs: ['req-headroom'],
      steps: [{
        id: 'step-confirm',
        order: 1,
        title: 'Confirm usable capacity',
        requirementRefs: ['req-headroom'],
        currentRef: 'obs-usable',
        evidenceRefs: ['ev-1'],
        citations: [],
        verify: 'Re-read usable capacity from the approved surface',
        stop: 'Stop if the value is unknown',
        recovery: 'Leave the case blocked and ask PM',
      }],
      prerequisites: [],
      unresolved: ['usable capacity is provided, not observed'],
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

function codes(input: unknown, auth: unknown = AUTH): string[] {
  const result = assembleEngineerCase(input, auth);
  return result.ok ? [] : result.issues.map((issue) => issue.code);
}

describe('engineer case contract', () => {
  it('accepts only the current schema version and documents reject-only compatibility', () => {
    expect(ENGINEER_CASE_SCHEMA_POLICY).toEqual({
      current: 'engineer-case.v1',
      accepted: ['engineer-case.v1'],
      unsupportedAction: 'reject',
    });
    expect(codes({ ...validFixtureCase(), schemaVersion: 'engineer-case.v0' })).toContain('UNSUPPORTED_SCHEMA_VERSION');
    expect(codes({ ...validFixtureCase(), schemaVersion: 'engineer-case.v2' })).toContain('UNSUPPORTED_SCHEMA_VERSION');
    expect(codes({ ...validFixtureCase(), schemaVersion: undefined })).toContain('UNSUPPORTED_SCHEMA_VERSION');
  });

  it('stamps authenticated tenant/project/actor and refuses body claims that differ', () => {
    const assembled = assembleEngineerCase(validFixtureCase(), AUTH);
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) throw new Error('expected ok');
    expect(assembled.value.tenantId).toBe(AUTH.tenantId);
    expect(assembled.value.projectId).toBe(AUTH.projectId);
    expect(assembled.value.actorId).toBe(AUTH.actorId);
    expect(assembled.guideReadyGranted).toBe(false);

    const missingAuth = assembleEngineerCase(validFixtureCase(), null);
    expect(missingAuth.ok).toBe(false);
    if (missingAuth.ok) throw new Error('expected auth refusal');
    expect(missingAuth.issues.map((item) => item.code)).toContain('AUTH_CONTEXT_REQUIRED');
    expect(codes(validFixtureCase({ tenantId: 'other-tenant' }))).toContain('UNTRUSTED_SCOPE_CLAIM');
    expect(codes(validFixtureCase({
      evidence: [{
        id: 'ev-1',
        digest: DIGEST,
        mediaType: 'application/json',
        sanitized: true,
        retention: 'case-revision',
        owner: { tenantId: AUTH.tenantId, projectId: 'other-proj', caseId: 'case-existing-1' },
      }],
    }))).toContain('CROSS_PROJECT_REF');
  });

  it('keeps derived formula identity and treats a real zero as distinct from unknown', () => {
    const assembled = assembleEngineerCase(validFixtureCase(), AUTH);
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) throw new Error('expected ok');
    const calculation = assembled.value.calculations[0];
    expect(calculation.sourceKind).toBe('derived');
    expect(calculation.formulaId).toBe('usable-headroom-ratio');
    expect(calculation.formulaVersion).toBe('1.0.0');
    expect(calculation.inputRefs).toEqual(['obs-usable']);
    expect(calculation.result).toEqual({ presence: 'known', data: { kind: 'number', number: 0, unit: 'percent' } });

    const unknown = serializeEngineerValue({ presence: 'unknown', reason: 'HA surface is not collected' });
    expect(unknown).toEqual({ presence: 'unknown', value: null, reason: 'HA surface is not collected' });
    expect(unknown.value).not.toBe(0);
    expect(unknown.value).not.toBe('PASS');
  });

  it('never grants guide ready from contract validation alone', () => {
    const assembled = assembleEngineerCase(validFixtureCase(), AUTH);
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) throw new Error('expected ok');
    expect(assembled.guideReadyGranted).toBe(false);
    expect(assembled.value.guide.readiness).toBe('blocked');
    expect(assembled.value.progress).toBe('draft');
    expect(assembled.value.execution.result).toBe('not_started');
    expect(assembled.value.assessments[0]?.status).toBe('unresolved');
  });

  it('rejects cross-project refs, broken ID links, and unsupported versions', () => {
    expect(codes(validFixtureCase({
      observations: [{
        id: 'obs-usable',
        projectId: 'other-proj',
        sourceKind: 'provided',
        collectionStatus: 'complete',
        value: { presence: 'known', data: { kind: 'number', number: 40, unit: 'TiB' } },
      }],
    }))).toContain('CROSS_PROJECT_REF');
    expect(codes(validFixtureCase({
      calculations: [{
        id: 'calc-headroom',
        sourceKind: 'derived',
        formulaId: 'usable-headroom-ratio',
        formulaVersion: '1.0.0',
        inputRefs: ['missing-obs'],
        assumptions: [],
        result: { presence: 'known', data: { kind: 'number', number: 1, unit: 'percent' } },
      }],
    }))).toContain('UNKNOWN_ID_REF');
    expect(codes({ ...validFixtureCase(), schemaVersion: 'not-a-case' })).toContain('UNSUPPORTED_SCHEMA_VERSION');
  });

  it('rejects NaN, Infinity, bad units, bad dates, and duplicate IDs', () => {
    expect(codes({
      ...validFixtureCase(),
      observations: [{
        id: 'obs-usable',
        sourceKind: 'provided',
        collectionStatus: 'complete',
        value: { presence: 'known', data: { kind: 'number', number: Number.NaN, unit: 'TiB' } },
      }],
    })).toContain('INVALID_NUMBER');
    expect(codes({
      ...validFixtureCase(),
      observations: [{
        id: 'obs-usable',
        sourceKind: 'provided',
        collectionStatus: 'complete',
        value: { presence: 'known', data: { kind: 'number', number: Number.POSITIVE_INFINITY, unit: 'TiB' } },
      }],
    })).toContain('INVALID_NUMBER');
    expect(codes({
      ...validFixtureCase(),
      observations: [{
        id: 'obs-usable',
        sourceKind: 'provided',
        collectionStatus: 'complete',
        value: { presence: 'known', data: { kind: 'number', number: 40, unit: 'bananas' } },
      }],
    })).toContain('INVALID_UNIT');
    expect(codes({
      ...validFixtureCase(),
      observations: [{
        id: 'obs-usable',
        sourceKind: 'provided',
        collectionStatus: 'complete',
        collectedAt: 'yesterday',
        value: { presence: 'known', data: { kind: 'number', number: 40, unit: 'TiB' } },
      }],
    })).toContain('INVALID_DATE');
    expect(codes({
      ...validFixtureCase(),
      observations: [
        {
          id: 'obs-usable',
          sourceKind: 'provided',
          collectionStatus: 'complete',
          value: { presence: 'known', data: { kind: 'number', number: 40, unit: 'TiB' } },
        },
        {
          id: 'obs-usable',
          sourceKind: 'provided',
          collectionStatus: 'complete',
          value: { presence: 'known', data: { kind: 'number', number: 1, unit: 'count' } },
        },
      ],
    })).toContain('DUPLICATE_ID');
  });

  it('refuses to serialize unknown as 0 or PASS', () => {
    expect(codes({
      ...validFixtureCase(),
      observations: [{
        id: 'obs-usable',
        sourceKind: 'unknown',
        collectionStatus: 'missing',
        unknownReason: 'not collected',
        value: { presence: 'known', data: { kind: 'number', number: 0, unit: 'count' } },
      }],
    })).toContain('UNKNOWN_COERCED');
    expect(codes({
      ...validFixtureCase(),
      observations: [{
        id: 'obs-usable',
        sourceKind: 'unknown',
        collectionStatus: 'missing',
        unknownReason: 'not collected',
        value: { presence: 'known', data: { kind: 'string', text: 'PASS' } },
      }],
    })).toContain('UNKNOWN_COERCED');
  });

  it('keeps fixture and missing-original snapshots from becoming observed', () => {
    expect(codes({
      ...validFixtureCase(),
      observations: [{
        id: 'obs-usable',
        sourceKind: 'observed',
        collectionStatus: 'complete',
        collectedAt: WHEN,
        factProvenance: LIVE_PROVENANCE,
        value: { presence: 'known', data: { kind: 'integer', integer: 1, unit: 'count' } },
      }],
    })).toEqual(expect.arrayContaining(['FIXTURE_MARKED_OBSERVED', 'MISSING_ORIGINAL_MARKED_OBSERVED']));

    expect(bindObservedFactToCase(LIVE_PROVENANCE, {
      caseId: 'case-existing-1',
      projectId: 'proj-a',
      observationId: 'obs-volumes',
      environmentKind: 'fixture',
      originalPresent: false,
    })).toEqual({ ok: false, reason: 'FIXTURE_MARKED_OBSERVED' });

    expect(bindObservedFactToCase(LIVE_PROVENANCE, {
      caseId: 'case-existing-1',
      projectId: 'proj-a',
      observationId: 'obs-volumes',
      environmentKind: 'live',
      originalPresent: true,
    })).toMatchObject({ ok: true, sourceKind: 'observed', provenance: LIVE_PROVENANCE });
  });

  it('accepts a live observed value only with complete provenance and auth scope', () => {
    const live = validFixtureCase({
      environmentKind: 'live',
      synthetic: false,
      originalPresent: true,
      observations: [{
        id: 'obs-volumes',
        sourceKind: 'observed',
        collectionStatus: 'complete',
        collectedAt: WHEN,
        factProvenance: LIVE_PROVENANCE,
        value: { presence: 'known', data: { kind: 'integer', integer: 3, unit: 'count' } },
      }],
      calculations: [{
        id: 'calc-headroom',
        sourceKind: 'derived',
        formulaId: 'usable-headroom-ratio',
        formulaVersion: '1.0.0',
        inputRefs: ['obs-volumes'],
        assumptions: ['volume count is observed'],
        result: { presence: 'known', data: { kind: 'integer', integer: 3, unit: 'count' } },
      }],
      assessments: [{
        id: 'assess-headroom',
        requirementRef: 'req-headroom',
        currentRef: 'obs-volumes',
        calculationRefs: ['calc-headroom'],
        status: 'unresolved',
        reasons: ['headroom formula still needs usable capacity'],
        nextAction: 'recollect',
      }],
      guide: {
        revision: 'guide-rev-1',
        digest: DIGEST,
        requirementRefs: ['req-headroom'],
        steps: [{
          id: 'step-confirm',
          order: 1,
          title: 'Confirm usable capacity',
          requirementRefs: ['req-headroom'],
          currentRef: 'obs-volumes',
          evidenceRefs: ['ev-1'],
          citations: [],
          verify: 'Re-read usable capacity from the approved surface',
          stop: 'Stop if the value is unknown',
          recovery: 'Leave the case blocked and ask PM',
        }],
        prerequisites: [],
        unresolved: ['usable capacity is still missing'],
        readiness: 'draft',
      },
    });
    const assembled = assembleEngineerCase(live, AUTH);
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) throw new Error('expected ok');
    expect(assembled.value.observations[0]?.sourceKind).toBe('observed');
    expect(assembled.value.guide.readiness).toBe('blocked');
    expect(assembled.guideReadyGranted).toBe(false);
  });

  it('rejects raw evidence paths and extra keys', () => {
    expect(codes({
      ...validFixtureCase(),
      evidence: [{
        id: 'ev-1',
        digest: DIGEST,
        mediaType: 'application/json',
        sanitized: true,
        retention: 'case-revision',
        path: '/var/data/secret.json',
      }],
    })).toContain('UNKNOWN_FIELD');
  });
});
