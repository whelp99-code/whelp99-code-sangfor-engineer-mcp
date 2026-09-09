import { describe, expect, it } from 'vitest';
import {
  bindRequiredObservationsToCase,
  buildHciCollectionSnapshot,
  importProvidedObservation,
} from '../packages/sangfor-config-state/src/index.js';
import {
  HCI_E03B_CAPABILITIES,
  HCI_E03B_REQUIRED_FIELDS,
  classifyRequiredReadAttempt,
  collectInventory,
  collectRequiredObservations,
  isProtocolRelativeHref,
  mapRequiredFieldFromApiPayload,
  resolveSameOriginPage,
  type HciClient,
  type HttpJsonResult,
} from '@sangfor/hci-client';
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
      unresolved: ['required observations are not a guide'],
      readiness: 'review_ready',
    },
    evidence: [],
    execution: { result: 'not_started' },
    ...overrides,
  };
}

describe('E03B required HCI observations', () => {
  it('defines support version, path, permission, evidence, and completeness for each required field', () => {
    expect(HCI_E03B_REQUIRED_FIELDS).toEqual([
      'host_cpu', 'host_ram', 'storage_usable_capacity', 'network_topology', 'ha_status',
    ]);
    expect(HCI_E03B_CAPABILITIES.map((row) => row.fieldId)).toEqual([...HCI_E03B_REQUIRED_FIELDS]);
    for (const row of HCI_E03B_CAPABILITIES) {
      expect(row.firmwareSupport).toBe('unknown');
      expect(row.firmwareSupportReason.length).toBeGreaterThan(0);
      expect(row.collectionPath).toBeNull();
      expect(row.permission.length).toBeGreaterThan(0);
      expect(row.evidence.length).toBeGreaterThan(0);
      expect(row.completeness).toBe('unsupported');
      expect(row.support).toBe('unsupported');
      expect(row.transport).toBe('none');
      expect(row.fieldAcceptanceBlockerResolved).toBe(false);
      expect(row.acquisition).toBe('manual-provided');
    }
  });

  it('keeps missing host/network/HA values unknown instead of 0 or false', async () => {
    const inventory = await collectInventory(client(), { collectedAt: WHEN });
    expect(inventory.guideReadyGranted).toBe(false);
    expect(inventory.requiredObservations.fieldAcceptanceBlockersResolved).toBe(false);
    expect(inventory.requiredObservations.mutationDispatchCount).toBe(0);
    expect(inventory.readRequests.every((read) => (
      read.path === '/volumes/detail' || read.path === '/servers' || read.path === '/v2/images'
    ))).toBe(true);

    for (const id of HCI_E03B_REQUIRED_FIELDS) {
      const field = inventory.requiredObservations.fields.find((item) => item.id === id);
      expect(field, id).toMatchObject({
        availability: 'missing',
        sourceKind: 'unknown',
        acquisition: 'unsupported',
        completeness: 'unsupported',
        fieldAcceptanceBlockerResolved: false,
        value: { presence: 'unknown' },
      });
      expect(field?.value.presence).toBe('unknown');
      expect(JSON.stringify(field)).not.toMatch(/"boolean":false/);
      expect(JSON.stringify(field?.value)).not.toMatch(/"integer":0/);
    }
    expect(inventory.fields.find((field) => field.id === 'volumes')?.acquisition).toBe('automatic');
    expect(inventory.fields.find((field) => field.id === 'ha_status')?.acquisition).toBe('unsupported');
  });

  it('distinguishes provided HA false from a missing HA boolean', () => {
    const missing = collectRequiredObservations();
    const haMissing = missing.fields.find((field) => field.id === 'ha_status');
    expect(haMissing?.value).toEqual({ presence: 'unknown', reason: 'NO_OFFICIAL_HA_READ_API' });
    expect(haMissing?.acquisition).toBe('unsupported');

    const providedFalse = collectRequiredObservations({
      providedFields: {
        ha_status: { presence: 'known', data: { kind: 'boolean', boolean: false } },
      },
    });
    const haFalse = providedFalse.fields.find((field) => field.id === 'ha_status');
    expect(haFalse).toMatchObject({
      availability: 'provided',
      sourceKind: 'provided',
      acquisition: 'manual-provided',
      value: { presence: 'known', data: { kind: 'boolean', boolean: false } },
    });
    expect(providedFalse.acquisition.ha_status).toBe('manual-provided');
    expect(providedFalse.acquisition.host_cpu).toBe('unsupported');
    expect(providedFalse.fieldAcceptanceBlockersResolved).toBe(false);
  });

  it('does not invent host CPU/RAM from a guessed hypervisor payload', async () => {
    const payload = { hypervisors: [{ vcpus: 32, memory_mb: 65536, ha_enabled: false }] };
    expect(mapRequiredFieldFromApiPayload('host_cpu', payload)).toEqual({
      mapped: false,
      reason: 'NO_OFFICIAL_HOST_CPU_API',
      value: { presence: 'unknown', reason: 'NO_OFFICIAL_HOST_CPU_API' },
    });
    expect(mapRequiredFieldFromApiPayload('host_ram', payload).value.presence).toBe('unknown');
    expect(mapRequiredFieldFromApiPayload('ha_status', payload).value).toEqual({
      presence: 'unknown',
      reason: 'NO_OFFICIAL_HA_READ_API',
    });

    const inventory = await collectInventory({
      async request(service, _path, init) {
        expect(init?.method ?? 'GET').toBe('GET');
        if (service === 'volume') return response({ volumes: [volume], ...payload });
        if (service === 'compute') return response({ servers: [{ id: 's1' }] });
        return response({ images: [] });
      },
    }, { collectedAt: WHEN });
    expect(inventory.originalPresentSurfaces).toBeUndefined();
    expect(inventory.requiredObservations.fields.find((field) => field.id === 'host_cpu')?.value.presence).toBe('unknown');
    expect(JSON.stringify(inventory.requiredObservations.fields.find((field) => field.id === 'host_cpu')?.value))
      .not.toMatch(/"integer":0/);
  });

  it('refuses forged endpoints, auth failures, unsupported firmware, and schema-shaped payloads', () => {
    expect(classifyRequiredReadAttempt({ endpoint: 'GET /os-hypervisors/detail' })).toBe('FORGED_ENDPOINT');
    expect(collectRequiredObservations({
      attemptedRequiredReads: [{ endpoint: 'GET /os-hypervisors/detail', fieldId: 'host_cpu' }],
    }).fields.find((field) => field.id === 'host_cpu')).toMatchObject({
      availability: 'missing',
      reason: 'FORGED_ENDPOINT',
      value: { presence: 'unknown', reason: 'FORGED_ENDPOINT' },
    });

    expect(classifyRequiredReadAttempt({ endpoint: 'GET /os-hypervisors', status: 403 })).toBe('AUTH_FAILED');
    const denied = collectRequiredObservations({
      attemptedRequiredReads: [{ endpoint: 'GET /os-hypervisors', status: 403, fieldId: 'host_ram' }],
    });
    expect(denied.fields.find((field) => field.id === 'host_ram')).toMatchObject({
      collectionStatus: 'failed',
      reason: 'AUTH_FAILED',
      value: { presence: 'unknown', reason: 'AUTH_FAILED' },
    });
    expect(denied.fields.find((field) => field.id === 'host_ram')?.value).not.toEqual({
      presence: 'known',
      data: { kind: 'boolean', boolean: false },
    });

    expect(classifyRequiredReadAttempt(
      { endpoint: 'GET /os-hypervisors' },
      { firmwareVersion: 'unlisted-9.9.9' },
    )).toBe('UNSUPPORTED_FIRMWARE');
    expect(collectRequiredObservations({
      firmwareVersion: 'unlisted-9.9.9',
      attemptedRequiredReads: [{ endpoint: 'GET /os-hypervisors', fieldId: 'host_cpu' }],
    }).fields.find((field) => field.id === 'host_cpu')?.reason).toBe('UNSUPPORTED_FIRMWARE');

    expect(classifyRequiredReadAttempt({
      endpoint: 'GET /openstack/network/v2.0/networks',
      payload: { networks: [] },
    })).toBe('SCHEMA_CHANGED');
  });

  it('refuses protocol-relative and external-origin next or collection links', () => {
    const serviceBase = 'http://127.0.0.1:3400/openstack/volume/v2/lab';
    expect(isProtocolRelativeHref('//untrusted.invalid/stolen')).toBe(true);
    expect(resolveSameOriginPage('//untrusted.invalid/stolen', serviceBase))
      .toEqual({ ok: false, reason: 'EXTERNAL_ORIGIN' });
    expect(classifyRequiredReadAttempt({ endpoint: '//untrusted.invalid/os-hypervisors' })).toBe('EXTERNAL_ORIGIN');
    expect(classifyRequiredReadAttempt({ endpoint: 'GET https://untrusted.invalid/os-hypervisors' })).toBe('EXTERNAL_ORIGIN');
    expect(collectRequiredObservations({
      attemptedRequiredReads: [{ endpoint: '//untrusted.invalid/ha', fieldId: 'ha_status' }],
    }).fields.find((field) => field.id === 'ha_status')?.reason).toBe('EXTERNAL_ORIGIN');
  });

  it('shows automatic versus manual acquisition and never grants guide ready', async () => {
    const inventory = await collectInventory(client(), {
      collectedAt: WHEN,
      providedFields: {
        host_cpu: { presence: 'known', data: { kind: 'integer', integer: 16, unit: 'cores' } },
      },
    });
    expect(inventory.requiredObservations.acquisition).toEqual({
      host_cpu: 'manual-provided',
      host_ram: 'unsupported',
      storage_usable_capacity: 'unsupported',
      network_topology: 'unsupported',
      ha_status: 'unsupported',
    });
    expect(inventory.fields.find((field) => field.id === 'volumes')?.acquisition).toBe('automatic');
    expect(inventory.guideReadyGranted).toBe(false);

    const snapshot = buildHciCollectionSnapshot(inventory, {
      caseId: 'case-existing-1',
      projectId: AUTH.projectId,
      environmentKind: 'fixture',
      originalPresent: false,
    });
    expect(snapshot.guideReadyGranted).toBe(false);
    expect(snapshot.requiredObservations.guideReadyGranted).toBe(false);
    expect(snapshot.requiredObservations.fieldAcceptanceBlockersResolved).toBe(false);
    expect(snapshot.requiredObservations.acquisition.host_cpu).toBe('manual-provided');
    expect(snapshot.requiredObservations.observations.find((item) => item.id === 'obs-host_cpu')).toMatchObject({
      sourceKind: 'provided',
      value: { presence: 'known', data: { kind: 'integer', integer: 16, unit: 'cores' } },
    });
    expect(snapshot.requiredObservations.observations.find((item) => item.id === 'obs-ha_status')).toMatchObject({
      sourceKind: 'unknown',
      value: { presence: 'unknown' },
    });
    expect(snapshot.observations.every((item) => item.sourceKind !== 'observed')).toBe(true);

    const assembled = assembleEngineerCase(caseShell({
      observations: [...snapshot.observations, ...snapshot.requiredObservations.observations],
    }), AUTH);
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) throw new Error('expected fixture required observations to assemble');
    expect(assembled.guideReadyGranted).toBe(false);
    expect(assembled.value.guide.readiness).toBe('blocked');
  });

  it('binds live observed inventory only through bindObservedFactToCase and keeps E03B non-observed', async () => {
    const inventory = await collectInventory(client(), { collectedAt: WHEN });
    const live = buildHciCollectionSnapshot(inventory, {
      caseId: 'case-existing-1',
      projectId: AUTH.projectId,
      environmentKind: 'live',
      originalPresent: true,
    });
    expect(live.observations.map((item) => item.sourceKind)).toEqual(['observed', 'observed', 'observed']);
    expect(live.requiredObservations.observations.every((item) => item.sourceKind !== 'observed')).toBe(true);

    const bound = bindRequiredObservationsToCase(inventory.requiredObservations, {
      caseId: 'case-existing-1',
      projectId: AUTH.projectId,
    });
    expect(bound.observations.every((item) => item.sourceKind !== 'observed')).toBe(true);
    expect(bound.fieldAcceptanceBlockersResolved).toBe(false);
  });

  it('imports a manual required field as provided and refuses to mark it observed', () => {
    const imported = importProvidedObservation({
      id: 'obs-ha_status',
      caseId: 'case-existing-1',
      projectId: AUTH.projectId,
      value: { presence: 'known', data: { kind: 'boolean', boolean: false } },
    });
    expect(imported.sourceKind).toBe('provided');
    expect(imported.value).toEqual({ presence: 'known', data: { kind: 'boolean', boolean: false } });
    expect(imported).not.toMatchObject({ sourceKind: 'observed' });
  });
});
