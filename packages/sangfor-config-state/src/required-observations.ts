import type {
  EngineerCollectionStatus,
  EngineerKnownValue,
  EngineerObservation,
  EngineerValue,
} from '../../shared/src/engineer-case-contract.js';
export const HCI_E03B_FIELD_IDS = [
  'host_cpu',
  'host_ram',
  'storage_usable_capacity',
  'network_topology',
  'ha_status',
] as const;

export type HciE03bFieldId = (typeof HCI_E03B_FIELD_IDS)[number];
export type HciRequiredObservationAcquisition = 'automatic' | 'manual-provided' | 'unsupported';

export type HciRequiredObservationField = {
  readonly id: HciE03bFieldId;
  readonly availability: 'provided' | 'missing';
  readonly reason: string;
  readonly collectionStatus: EngineerCollectionStatus | 'unknown';
  readonly sourceKind: 'provided' | 'unknown';
  readonly acquisition: HciRequiredObservationAcquisition;
  readonly value:
    | { readonly presence: 'known'; readonly data: EngineerKnownValue }
    | { readonly presence: 'unknown'; readonly reason: string };
};

export type HciRequiredObservationInput = {
  readonly fields: readonly HciRequiredObservationField[];
  readonly acquisition: Readonly<Record<HciE03bFieldId, HciRequiredObservationAcquisition>>;
  readonly guideReadyGranted: false;
  readonly fieldAcceptanceBlockersResolved: false;
};

export type HciRequiredObservationBinding = {
  readonly observations: readonly EngineerObservation[];
  readonly acquisition: Readonly<Record<HciE03bFieldId, HciRequiredObservationAcquisition>>;
  readonly missingFields: readonly HciE03bFieldId[];
  readonly fieldAcceptanceBlockersResolved: false;
  readonly guideReadyGranted: false;
};

function toValue(value: HciRequiredObservationField['value']): EngineerValue {
  if (value.presence === 'unknown') return { presence: 'unknown', reason: value.reason };
  return { presence: 'known', data: value.data };
}

function toCollectionStatus(status: string): EngineerCollectionStatus {
  if (status === 'complete' || status === 'partial' || status === 'missing' || status === 'failed' || status === 'unsupported') {
    return status;
  }
  return 'failed';
}

/**
 * Bind E03B required fields to case observations.
 * Automatic live observed is impossible while those surfaces are unsupported.
 * Provided values stay provided. Collection never grants guide ready.
 */
export function bindRequiredObservationsToCase(
  required: HciRequiredObservationInput,
  binding: { readonly caseId: string; readonly projectId: string },
): HciRequiredObservationBinding {
  const observations = required.fields.map((field) => {
    const observation: EngineerObservation = {
      id: `obs-${field.id}`,
      caseId: binding.caseId,
      projectId: binding.projectId,
      sourceKind: field.sourceKind,
      collectionStatus: toCollectionStatus(field.collectionStatus),
      value: toValue(field.value),
      ...(field.value.presence === 'unknown' ? { unknownReason: field.value.reason } : {}),
    };
    return observation;
  });
  return {
    observations,
    acquisition: required.acquisition,
    missingFields: required.fields.filter((field) => field.availability === 'missing').map((field) => field.id),
    fieldAcceptanceBlockersResolved: false,
    guideReadyGranted: false,
  };
}
