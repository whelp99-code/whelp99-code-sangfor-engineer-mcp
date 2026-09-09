import { describe, expect, it } from 'vitest';
import {
  buildHciCollectionSnapshot,
  importProvidedObservation,
} from '../packages/sangfor-config-state/src/index.js';
import { collectInventory, type HciClient, type HttpJsonResult } from '@sangfor/hci-client';
import { assembleEngineerCase } from '../packages/sangfor-planner/src/engineer-case.js';
import {
  ENGINEER_CASE_SCHEMA_VERSION,
  type EngineerCaseDocument,
} from '../packages/shared/src/engineer-case-contract.js';

const volume = { id: 'v1', name: 'data', status: 'available', size: 1, description: null };
const WHEN = '2026-09-09T00:00:00.000Z';
const AUTH = { tenantId: 'tenant-a', projectId: 'proj-a', actorId: 'actor-a' } as const;
const DIGEST = 'ab'.repeat(32);

const response = (json: unknown, status = 200): HttpJsonResult => ({ json, status, text: JSON.stringify(json) });

function client(): Pick<HciClient, 'request'> {
  return {
    async request(service, _path, init) {
      expect(init?.method ?? 'GET').toBe('GET');
      if (service === 'volume') return response({ volumes: [volume] });
      if (service === 'compute') return response({ servers: [{ id: 's1' }] });
      return response({ images: [] });
    },
  };
}

function caseShell(overrides: Partial<EngineerCaseDocument> = {}): EngineerCaseDocument {
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
    observations: [],
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
    calculations: [],
    assessments: [],
    guide: {
      revision: 'guide-rev-1',
      digest: DIGEST,
      requirementRefs: ['req-headroom'],
      steps: [],
      prerequisites: [],
      unresolved: ['collection snapshot is not a guide'],
      readiness: 'review_ready',
    },
    evidence: [],
    execution: { result: 'not_started' },
    ...overrides,
  };
}

describe('HCI collection snapshot binding', () => {
  it('keeps fixture inventory provided and never grants guide ready from collection', async () => {
    const inventory = await collectInventory(client(), { collectedAt: WHEN });
    const snapshot = buildHciCollectionSnapshot(inventory, {
      caseId: 'case-existing-1',
      projectId: AUTH.projectId,
      environmentKind: 'fixture',
      originalPresent: false,
    });
    expect(snapshot.persisted).toBe(false);
    expect(snapshot.guideReadyGranted).toBe(false);
    expect(snapshot.mutationDispatchCount).toBe(0);
    expect(snapshot.observations.every((item) => item.sourceKind !== 'observed')).toBe(true);
    expect(snapshot.observations.find((item) => item.id === 'obs-volumes')?.sourceKind).toBe('provided');
    expect(snapshot.missingFields.some((field) => field.id === 'ha_status')).toBe(true);

    const assembled = assembleEngineerCase(caseShell({
      observations: snapshot.observations,
    }), AUTH);
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) throw new Error('expected fixture snapshot to assemble');
    expect(assembled.guideReadyGranted).toBe(false);
    expect(assembled.value.guide.readiness).toBe('blocked');
  });

  it('binds live observed facts only through bindObservedFactToCase', async () => {
    const inventory = await collectInventory(client(), { collectedAt: WHEN });
    const live = buildHciCollectionSnapshot(inventory, {
      caseId: 'case-existing-1',
      projectId: AUTH.projectId,
      environmentKind: 'live',
      originalPresent: true,
    });
    expect(live.observations.map((item) => item.sourceKind)).toEqual(['observed', 'observed', 'observed']);
    expect(live.observations[0]?.factProvenance?.endpoint).toBe('GET /volumes/detail');
    expect(live.observations[0]?.value).toEqual({
      presence: 'known',
      data: { kind: 'integer', integer: 1, unit: 'count' },
    });
    expect(live.observations[2]?.value).toEqual({
      presence: 'known',
      data: { kind: 'integer', integer: 0, unit: 'count' },
    });

    const omittedOriginal = buildHciCollectionSnapshot(inventory, {
      caseId: 'case-existing-1',
      projectId: AUTH.projectId,
      environmentKind: 'live',
      originalPresent: false,
    });
    expect(omittedOriginal.observations.every((item) => item.sourceKind !== 'observed')).toBe(true);
  });

  it('imports a manual field as provided and refuses to mark it observed', () => {
    const imported = importProvidedObservation({
      id: 'obs-ha-status',
      caseId: 'case-existing-1',
      projectId: AUTH.projectId,
      value: { presence: 'known', data: { kind: 'string', text: 'HA enabled' } },
    });
    expect(imported.sourceKind).toBe('provided');
    expect(imported.collectionStatus).toBe('complete');
    expect(imported).not.toMatchObject({ sourceKind: 'observed' });
  });
});
