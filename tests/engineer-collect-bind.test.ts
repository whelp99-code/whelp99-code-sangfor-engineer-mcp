import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  bindEngineerAuthorizedDeviceReadEvidence,
  bindHciCollectAuthorizedDeviceReadEvidence,
  bindHciCollectToFieldAcceptanceObservations,
  isMockConsoleOrigin,
  MAPPER_VERSION,
  type HciCollectOriginalPresentSurface,
} from '../packages/sangfor-config-state/src/index.js';
import { collectInventory, type HciClient, type HttpJsonResult, type InventoryClient } from '@sangfor/hci-client';
import {
  ENGINEER_REQUIRED_LIVE_READ_SURFACES,
  type EngineerRequiredLiveReadSurfaceId,
} from '../packages/shared/src/engineer-field-acceptance.js';
import { BlroAuthorityStore } from '../packages/sangfor-authority/src/authority-store.js';
import {
  ENGINEER_CASE_READ_PERMISSION,
  ENGINEER_CASE_WRITE_PERMISSION,
} from '../packages/sangfor-authority/src/authority-store-contracts.js';
import { FakeEngineerCaseAuthorityDatabase } from './helpers/engineer-case-authority-db.js';
import { fixtureInventoryClient, runEngineerWorkflow } from './support/engineer-workflow-pipeline.js';

const WHEN = '2026-09-10T00:00:00.000Z';
const AUTH = { tenantId: 'tenant-a', projectId: 'proj-a', actorId: 'actor-a' } as const;
const TARGET = 'https://hci-lab.example.test:4430/openstack/identity/v2.0';
const MOCK = 'http://127.0.0.1:3400/openstack/identity/v2.0';
const volume = { id: 'v1', name: 'data', status: 'available', size: 1, description: null };

const response = (json: unknown, status = 200): HttpJsonResult => ({ json, status, text: JSON.stringify(json) });

function stubClient(origin: string): InventoryClient {
  return {
    async endpointFor() {
      return origin;
    },
    async request(service, _path, init) {
      expect(init?.method ?? 'GET').toBe('GET');
      if (service === 'volume') return response({ volumes: [volume] });
      if (service === 'compute') return response({ servers: [{ id: 's1' }] });
      return response({ images: [] });
    },
  };
}

async function collectAuthorized(origin = TARGET) {
  return collectInventory(stubClient(origin), {
    collectedAt: WHEN,
    request: { target: origin },
  });
}

const SYNTHETIC_COLLECTOR = 'e12-collect-bind-synthetic-not-a-device';
const REST_SURFACE_IDS = new Set<EngineerRequiredLiveReadSurfaceId>(['volumes', 'servers', 'images']);

function syntheticOriginalPresentSurfaces(): HciCollectOriginalPresentSurface[] {
  return ENGINEER_REQUIRED_LIVE_READ_SURFACES
    .map((surface) => surface.id)
    .filter((surfaceId) => !REST_SURFACE_IDS.has(surfaceId))
    .map((surfaceId) => ({
      surfaceId,
      originalPresent: true as const,
      fact: {
        transport: 'api' as const,
        endpoint: `GET /e12-synthetic/${surfaceId}`,
        mapperVersion: MAPPER_VERSION,
        collectedAt: WHEN,
        collector: SYNTHETIC_COLLECTOR,
      },
      payload: {
        kind: 'e12-collect-bind-synthetic',
        surfaceId,
        deviceCollect: false,
      },
    }));
}

function authorizedSession(origin = TARGET) {
  return {
    kind: 'authorized_device_collect' as const,
    declaredTarget: origin,
    measuredIdentityOrigin: origin,
    collectExecuted: true as const,
  };
}

describe('HCI collect → authorized-read binder', () => {
  it('does not treat mock console :3400 as an authorized origin', () => {
    expect(isMockConsoleOrigin(MOCK)).toBe(true);
    expect(isMockConsoleOrigin('http://127.0.0.1:3400/hci')).toBe(true);
    expect(isMockConsoleOrigin(TARGET)).toBe(false);
  });

  it('makes in-process collect facts usable by the grant binder without minting authorized_device_read', async () => {
    const inventory = await collectAuthorized();
    expect(inventory.collection.volumes.status).toBe('complete');
    const wired = bindHciCollectAuthorizedDeviceReadEvidence({
      inventory,
      caseId: 'case-collect-bind',
      projectId: AUTH.projectId,
      caseRevision: 'rev-collect-bind',
      guideRevision: 'guide-collect-bind',
      session: {
        kind: 'authorized_device_collect',
        declaredTarget: TARGET,
        measuredIdentityOrigin: TARGET,
        collectExecuted: true,
      },
    });
    expect(wired.collect.ok).toBe(true);
    if (!wired.collect.ok) throw new Error('expected collect facts to bind');
    expect(wired.collect.originalPresent).toBe(true);
    expect(wired.collect.observations.map((item) => item.surfaceId)).toEqual(['volumes', 'servers', 'images']);
    expect(wired.collect.observations.every((item) => item.originalPresent === true)).toBe(true);
    expect(wired.collect.observations.every((item) => item.environmentKind === 'live')).toBe(true);
    expect(wired.authorized.ok).toBe(false);
    if (wired.authorized.ok) throw new Error('stub collect must not mint authorized_device_read');
    expect(wired.authorized.reason).toBe('REQUIRED_LIVE_SURFACES_NOT_RUN');
    expect(wired.authorized.requiredLiveSurfaces.filter((item) => item.status === 'BOUND_ORIGINAL_PRESENT').map((item) => item.id))
      .toEqual(['volumes', 'servers', 'images']);
    expect(wired.authorized.requiredLiveSurfaces.filter((item) => item.id === 'host_cpu')[0]?.status).toBe('NOT_RUN');

    const rebound = bindEngineerAuthorizedDeviceReadEvidence({
      caseRevision: 'rev-collect-bind',
      guideRevision: 'guide-collect-bind',
      observations: wired.collect.observations,
    });
    expect(rebound.ok).toBe(false);
    if (rebound.ok) throw new Error('rebound stub collect must not mint authorized_device_read');
    expect(rebound.reason).toBe('REQUIRED_LIVE_SURFACES_NOT_RUN');
  });

  it('refuses fixture clients, mock console, historical kinds, and invented collector bytes', async () => {
    const liveShaped = await collectAuthorized();
    const fixtureInventory = await collectInventory({
      async request(service) {
        if (service === 'volume') return response({ volumes: [volume] });
        if (service === 'compute') return response({ servers: [{ id: 's1' }] });
        return response({ images: [] });
      },
    } satisfies Pick<HciClient, 'request'>, { collectedAt: WHEN });

    const fixtureSession = bindHciCollectToFieldAcceptanceObservations({
      inventory: fixtureInventory,
      caseId: 'case-collect-bind',
      projectId: AUTH.projectId,
      session: {
        kind: 'authorized_device_collect',
        declaredTarget: TARGET,
        measuredIdentityOrigin: TARGET,
        collectExecuted: true,
      },
    });
    expect(fixtureSession.ok).toBe(false);
    if (fixtureSession.ok) throw new Error('fixture inventory without request.target must not bind');
    expect(fixtureSession.reason).toBe('TARGET_UNVERIFIED');

    const mock = bindHciCollectToFieldAcceptanceObservations({
      inventory: await collectAuthorized(MOCK),
      caseId: 'case-collect-bind',
      projectId: AUTH.projectId,
      session: {
        kind: 'authorized_device_collect',
        declaredTarget: MOCK,
        measuredIdentityOrigin: MOCK,
        collectExecuted: true,
      },
    });
    expect(mock.ok).toBe(false);
    if (mock.ok) throw new Error('mock :3400 must not bind');
    expect(mock.reason).toBe('MOCK_CONSOLE_IS_NOT_FIELD_ACCEPTED');

    const historical = bindHciCollectToFieldAcceptanceObservations({
      inventory: liveShaped,
      caseId: 'case-collect-bind',
      projectId: AUTH.projectId,
      session: {
        kind: 'historical_record',
        declaredTarget: TARGET,
        measuredIdentityOrigin: TARGET,
        collectExecuted: true,
      },
    });
    expect(historical.ok).toBe(false);
    if (historical.ok) throw new Error('historical kind must not bind');
    expect(historical.reason).toBe('HISTORICAL_RECORD_IS_NOT_CURRENT_LIVE');

    const invented = bindHciCollectToFieldAcceptanceObservations({
      inventory: {
        ...liveShaped,
        provenance: {
          ...liveShaped.provenance,
          volumes: { ...liveShaped.provenance.volumes, collector: 'invented-bytes' },
        },
      },
      caseId: 'case-collect-bind',
      projectId: AUTH.projectId,
      session: {
        kind: 'authorized_device_collect',
        declaredTarget: TARGET,
        measuredIdentityOrigin: TARGET,
        collectExecuted: true,
      },
    });
    expect(invented.ok).toBe(true);
    if (!invented.ok) throw new Error('servers/images should still bind');
    expect(invented.observations.map((item) => item.surfaceId)).toEqual(['servers', 'images']);
    const inventedAuthorized = bindEngineerAuthorizedDeviceReadEvidence({
      caseRevision: 'rev-collect-bind',
      guideRevision: 'guide-collect-bind',
      observations: invented.observations,
    });
    expect(inventedAuthorized.ok).toBe(false);
    if (inventedAuthorized.ok) throw new Error('invented collector must not mint authorized_device_read');
  });

  it('keeps the fixture workflow e2e path fieldAccepted false and liveRead not_run', async () => {
    const db = new FakeEngineerCaseAuthorityDatabase();
    db.grant(AUTH, [ENGINEER_CASE_READ_PERMISSION, ENGINEER_CASE_WRITE_PERMISSION]);
    const store = new BlroAuthorityStore(db);
    const result = await runEngineerWorkflow({
      auth: AUTH,
      caseId: 'case-existing-hci',
      mode: 'existing',
      product: 'HCI_SCP',
      revision: 'rev-e12-collect-bind',
      requestId: 'e12-collect-bind-fixture',
      inventoryClient: fixtureInventoryClient({
        volumes: [volume],
        servers: [{ id: 's1' }],
        images: [],
      }),
      requirementTexts: ['usable headroom >= 20 percent'],
      persist: (input) => store.saveEngineerCase(input),
      exportRoot: mkdtempSync(join(tmpdir(), 'e12-collect-bind-')),
    });
    expect(result.fieldAccepted).toBe(false);
    expect(result.fieldAcceptance.fieldAccepted).toBe(false);
    expect(result.fieldAcceptance.liveRead).toBe('not_run');
    expect(result.fieldAcceptance.grantPath).toBe('none');
    expect(result.authorizedCollectBind).toBeUndefined();
    expect(result.liveProof).toBe(false);
  });

  it('wires an authorized stub collect into the grant sibling and still refuses field_accepted', async () => {
    const db = new FakeEngineerCaseAuthorityDatabase();
    db.grant(AUTH, [ENGINEER_CASE_READ_PERMISSION, ENGINEER_CASE_WRITE_PERMISSION]);
    const store = new BlroAuthorityStore(db);
    const result = await runEngineerWorkflow({
      auth: AUTH,
      caseId: 'case-authorized-stub',
      mode: 'existing',
      product: 'HCI_SCP',
      revision: 'rev-e12-authorized-stub',
      requestId: 'e12-collect-bind-auth',
      inventoryClient: stubClient(TARGET),
      authorizedCollect: { target: TARGET },
      requirementTexts: ['usable headroom >= 20 percent'],
      persist: (input) => store.saveEngineerCase(input),
      exportRoot: mkdtempSync(join(tmpdir(), 'e12-collect-bind-auth-')),
    });
    expect(result.collectFailed).toBe(false);
    expect(result.authorizedCollectBind?.observationCount).toBe(3);
    expect(result.authorizedCollectBind?.authorizedDeviceRead).toBe(false);
    expect(result.authorizedCollectBind?.reason).toBe('REQUIRED_LIVE_SURFACES_NOT_RUN');
    expect(result.fieldAccepted).toBe(false);
    expect(result.fieldAcceptance.fieldAccepted).toBe(false);
    expect(result.fieldAcceptance.liveRead).toBe('refused');
    expect(result.fieldAcceptance.grantPath).toBe('none');
    expect(result.fieldAcceptance.refusedReasons).toEqual(expect.arrayContaining([
      'REQUIRED_LIVE_SURFACES_NOT_RUN',
    ]));
    expect(result.fieldAcceptance.requiredLiveSurfaces.filter((item) => item.status === 'BOUND_ORIGINAL_PRESENT').map((item) => item.id))
      .toEqual(['volumes', 'servers', 'images']);
    expect(result.document?.observations.filter((item) => item.sourceKind === 'observed').map((item) => item.id))
      .toEqual(['obs-volumes', 'obs-servers', 'obs-images']);
    expect(result.liveProof).toBe(false);
  });

  it('mints authorized_device_read only when collect also binds firmware, collectedAt, and E03B originalPresent facts', async () => {
    const inventory = await collectAuthorized();
    const extras = syntheticOriginalPresentSurfaces();
    expect(extras.map((item) => item.surfaceId)).toEqual([
      'collectedAt',
      'volume_status_health',
      'firmware',
      'host_cpu',
      'host_ram',
      'storage_usable_capacity',
      'network_topology',
      'ha_status',
    ]);
    const wired = bindHciCollectAuthorizedDeviceReadEvidence({
      inventory: { ...inventory, originalPresentSurfaces: extras },
      caseId: 'case-collect-bind-full',
      projectId: AUTH.projectId,
      caseRevision: 'rev-collect-bind-full',
      guideRevision: 'guide-collect-bind-full',
      session: authorizedSession(),
    });
    expect(wired.collect.ok).toBe(true);
    if (!wired.collect.ok) throw new Error('expected synthetic originalPresent extras to pass through');
    expect(wired.collect.observations).toHaveLength(ENGINEER_REQUIRED_LIVE_READ_SURFACES.length);
    expect(wired.authorized.ok).toBe(true);
    if (!wired.authorized.ok) throw new Error(`expected binder mint after originalPresent extras: ${wired.authorized.reason}`);
    expect(wired.authorized.sourceKind).toBe('authorized_device_read');
    expect(wired.authorized.bound.map((item) => item.surfaceId).sort()).toEqual(
      ENGINEER_REQUIRED_LIVE_READ_SURFACES.map((surface) => surface.id).sort(),
    );
    expect(wired.authorized.requiredLiveSurfaces.every((item) => item.status === 'BOUND_ORIGINAL_PRESENT')).toBe(true);
  });

  it('does not invent collectedAt, firmware, volume_status_health, or E03B from timestamps, options, or provided fields', async () => {
    const inventory = await collectInventory(stubClient(TARGET), {
      collectedAt: WHEN,
      firmwareVersion: 'e12-option-is-not-a-device-read',
      request: { target: TARGET },
      providedFields: {
        host_cpu: { presence: 'known', data: { kind: 'integer', integer: 16, unit: 'cores' } },
        ha_status: { presence: 'known', data: { kind: 'boolean', boolean: true } },
      },
    });
    expect(inventory.fields.find((field) => field.id === 'firmware')?.sourceKind).toBe('provided');
    expect(inventory.requiredObservations.fields.find((field) => field.id === 'host_cpu')?.sourceKind).toBe('provided');
    const wired = bindHciCollectAuthorizedDeviceReadEvidence({
      inventory,
      caseId: 'case-collect-bind-no-invent',
      projectId: AUTH.projectId,
      caseRevision: 'rev-collect-bind-no-invent',
      guideRevision: 'guide-collect-bind-no-invent',
      session: authorizedSession(),
    });
    expect(wired.collect.ok).toBe(true);
    if (!wired.collect.ok) throw new Error('expected REST surfaces to bind');
    expect(wired.collect.observations.map((item) => item.surfaceId)).toEqual(['volumes', 'servers', 'images']);
    expect(wired.authorized.ok).toBe(false);
    if (wired.authorized.ok) throw new Error('option/provided collect must not mint authorized_device_read');
    expect(wired.authorized.reason).toBe('REQUIRED_LIVE_SURFACES_NOT_RUN');
    const bound = wired.authorized.requiredLiveSurfaces
      .filter((item) => item.status === 'BOUND_ORIGINAL_PRESENT')
      .map((item) => item.id);
    expect(bound).toEqual(['volumes', 'servers', 'images']);
    expect(bound).not.toContain('collectedAt');
    expect(bound).not.toContain('firmware');
    expect(bound).not.toContain('volume_status_health');
    expect(bound).not.toContain('host_cpu');
    expect(wired.authorized.requiredLiveSurfaces.filter((item) => item.layer === 'E03B').every((item) => item.status === 'NOT_RUN')).toBe(true);
  });

  it('still refuses fixture and mock when synthetic originalPresent extras are attached', async () => {
    const extras = syntheticOriginalPresentSurfaces();
    const mock = bindHciCollectAuthorizedDeviceReadEvidence({
      inventory: { ...(await collectAuthorized(MOCK)), originalPresentSurfaces: extras },
      caseId: 'case-collect-bind-mock-extras',
      projectId: AUTH.projectId,
      caseRevision: 'rev-collect-bind-mock-extras',
      guideRevision: 'guide-collect-bind-mock-extras',
      session: authorizedSession(MOCK),
    });
    expect(mock.collect.ok).toBe(false);
    if (mock.collect.ok) throw new Error('mock :3400 plus extras must not bind');
    expect(mock.collect.reason).toBe('MOCK_CONSOLE_IS_NOT_FIELD_ACCEPTED');
    expect(mock.authorized.ok).toBe(false);

    const fixtureInventory = await collectInventory({
      async request(service) {
        if (service === 'volume') return response({ volumes: [volume] });
        if (service === 'compute') return response({ servers: [{ id: 's1' }] });
        return response({ images: [] });
      },
    } satisfies Pick<HciClient, 'request'>, { collectedAt: WHEN });
    const fixture = bindHciCollectAuthorizedDeviceReadEvidence({
      inventory: { ...fixtureInventory, originalPresentSurfaces: extras },
      caseId: 'case-collect-bind-fixture-extras',
      projectId: AUTH.projectId,
      caseRevision: 'rev-collect-bind-fixture-extras',
      guideRevision: 'guide-collect-bind-fixture-extras',
      session: authorizedSession(),
    });
    expect(fixture.collect.ok).toBe(false);
    if (fixture.collect.ok) throw new Error('fixture inventory plus extras must not bind');
    expect(fixture.collect.reason).toBe('TARGET_UNVERIFIED');
    expect(fixture.authorized.ok).toBe(false);
    if (fixture.authorized.ok) throw new Error('fixture plus extras must not mint authorized_device_read');
  });
});
