import {
  type EngineerCollectionStatus,
  type EngineerEnvironmentKind,
  type EngineerObservation,
  type EngineerValue,
} from '../../shared/src/engineer-case-contract.js';
import { bindObservedFactToCase, type FactProvenance } from './provenance.js';

export type HciCollectionSnapshotSurface = 'volumes' | 'servers' | 'images';

export type HciCollectionSnapshotInventory = {
  readonly volumes: readonly unknown[];
  readonly servers: readonly unknown[];
  readonly images: readonly unknown[];
  readonly collectedAt: string;
  readonly collectionRevision: string;
  readonly persisted: false;
  readonly guideReadyGranted: false;
  readonly mutationDispatchCount: 0;
  readonly fields: readonly {
    readonly id: string;
    readonly availability: 'collected' | 'provided' | 'missing';
    readonly reason: string;
    readonly collectionStatus: EngineerCollectionStatus | 'unknown';
    readonly sourceKind: 'observed' | 'provided' | 'unknown';
    readonly importPath?: 'manual-provided';
  }[];
  readonly collection: Record<HciCollectionSnapshotSurface, { status: string; reason?: string }>;
  readonly provenance: Record<HciCollectionSnapshotSurface, FactProvenance>;
  readonly request?: {
    readonly target?: string;
    readonly firmwareVersion?: string;
    readonly surfaces?: readonly string[];
  };
};

export type HciCollectionSnapshotBinding = {
  readonly caseId: string;
  readonly projectId: string;
  readonly environmentKind: EngineerEnvironmentKind;
  readonly originalPresent: boolean;
};

export type HciCollectionSnapshot = {
  readonly schema: 'hci-collection-snapshot.v1';
  readonly persisted: false;
  readonly collectionRevision: string;
  readonly collectedAt: string;
  readonly environmentKind: EngineerEnvironmentKind;
  readonly originalPresent: boolean;
  readonly observations: readonly EngineerObservation[];
  readonly fields: HciCollectionSnapshotInventory['fields'];
  readonly missingFields: HciCollectionSnapshotInventory['fields'];
  readonly manualImport: {
    readonly allowed: true;
    readonly promotesTo: 'provided';
    readonly neverObserved: true;
  };
  readonly mutationDispatchCount: 0;
  readonly guideReadyGranted: false;
};

const SURFACE_UNITS = {
  volumes: 'count',
  servers: 'count',
  images: 'count',
} as const;

function observationId(surface: HciCollectionSnapshotSurface): string {
  return `obs-${surface}`;
}

function knownCount(count: number): EngineerValue {
  return { presence: 'known', data: { kind: 'integer', integer: count, unit: 'count' } };
}

function unknownValue(reason: string): EngineerValue {
  return { presence: 'unknown', reason };
}

function surfaceItems(inventory: HciCollectionSnapshotInventory, surface: HciCollectionSnapshotSurface): readonly unknown[] {
  return inventory[surface];
}

function toCollectionStatus(status: string): EngineerCollectionStatus {
  if (status === 'complete' || status === 'partial' || status === 'missing' || status === 'failed' || status === 'unsupported') {
    return status;
  }
  return 'failed';
}

function providedObservation(
  surface: HciCollectionSnapshotSurface,
  inventory: HciCollectionSnapshotInventory,
  binding: HciCollectionSnapshotBinding,
): EngineerObservation {
  const status = toCollectionStatus(inventory.collection[surface].status);
  const count = surfaceItems(inventory, surface).length;
  if (status === 'failed' || status === 'missing' || status === 'unsupported') {
    const reason = inventory.collection[surface].reason ?? 'NOT_COLLECTED';
    return {
      id: observationId(surface),
      caseId: binding.caseId,
      projectId: binding.projectId,
      sourceKind: 'unknown',
      collectionStatus: status,
      collectedAt: inventory.collectedAt,
      unknownReason: reason,
      value: unknownValue(reason),
    };
  }
  return {
    id: observationId(surface),
    caseId: binding.caseId,
    projectId: binding.projectId,
    sourceKind: 'provided',
    collectionStatus: status,
    collectedAt: inventory.collectedAt,
    factProvenance: inventory.provenance[surface],
    value: knownCount(count),
  };
}

function observedOrUnknown(
  surface: HciCollectionSnapshotSurface,
  inventory: HciCollectionSnapshotInventory,
  binding: HciCollectionSnapshotBinding,
): EngineerObservation {
  const status = toCollectionStatus(inventory.collection[surface].status);
  if (status === 'failed' || status === 'missing' || status === 'unsupported') {
    return providedObservation(surface, inventory, binding);
  }
  const bound = bindObservedFactToCase(inventory.provenance[surface], {
    caseId: binding.caseId,
    projectId: binding.projectId,
    observationId: observationId(surface),
    environmentKind: binding.environmentKind,
    originalPresent: binding.originalPresent,
  });
  if (!bound.ok) {
    return {
      id: observationId(surface),
      caseId: binding.caseId,
      projectId: binding.projectId,
      sourceKind: 'unknown',
      collectionStatus: status,
      collectedAt: inventory.collectedAt,
      unknownReason: bound.reason,
      value: unknownValue(bound.reason),
    };
  }
  return {
    id: bound.observationId,
    caseId: bound.caseId,
    projectId: bound.projectId,
    sourceKind: 'observed',
    collectionStatus: status,
    collectedAt: inventory.collectedAt,
    factProvenance: bound.provenance,
    value: knownCount(surfaceItems(inventory, surface).length),
  };
}

/**
 * Bind a masked HCI inventory run to engineer-case observations.
 * Durable storage/revision issuance stays with E09A/E09B.
 * Collection success never grants guide ready.
 */
export function buildHciCollectionSnapshot(
  inventory: HciCollectionSnapshotInventory,
  binding: HciCollectionSnapshotBinding,
): HciCollectionSnapshot {
  const liveObserved = binding.environmentKind === 'live' && binding.originalPresent === true;
  const observations: EngineerObservation[] = (['volumes', 'servers', 'images'] as const).map((surface) => (
    liveObserved
      ? observedOrUnknown(surface, inventory, binding)
      : providedObservation(surface, inventory, binding)
  ));
  return {
    schema: 'hci-collection-snapshot.v1',
    persisted: false,
    collectionRevision: inventory.collectionRevision,
    collectedAt: inventory.collectedAt,
    environmentKind: binding.environmentKind,
    originalPresent: binding.originalPresent,
    observations,
    fields: inventory.fields,
    missingFields: inventory.fields.filter((field) => field.availability === 'missing'),
    manualImport: { allowed: true, promotesTo: 'provided', neverObserved: true },
    mutationDispatchCount: 0,
    guideReadyGranted: false,
  };
}

/** Manual import stays provided. It is never promoted to observed. */
export function importProvidedObservation(input: {
  readonly id: string;
  readonly caseId?: string;
  readonly projectId?: string;
  readonly value: EngineerValue;
  readonly reason?: string;
}): EngineerObservation {
  if (input.value.presence !== 'known') {
    return {
      id: input.id,
      ...(input.caseId ? { caseId: input.caseId } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
      sourceKind: 'unknown',
      collectionStatus: 'missing',
      unknownReason: input.reason ?? 'MANUAL_VALUE_UNKNOWN',
      value: input.value,
    };
  }
  return {
    id: input.id,
    ...(input.caseId ? { caseId: input.caseId } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    sourceKind: 'provided',
    collectionStatus: 'complete',
    value: input.value,
  };
}

export const HCI_COLLECTION_SNAPSHOT_UNITS = SURFACE_UNITS;
