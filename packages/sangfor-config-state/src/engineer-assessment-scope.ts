/**
 * Scope and evidence checks for engineer-case compare (E06).
 *
 * Snapshot inventory observations are not E03B capability rows.
 * Live observed still requires bindObservedFactToCase / originalPresent.
 */
import type {
  EngineerAssessment,
  EngineerCaseDocument,
  EngineerObservation,
} from '../../shared/src/engineer-case-contract.js';
import { bindObservedFactToCase } from './provenance.js';
import { HCI_E03B_FIELD_IDS, type HciE03bFieldId } from './required-observations.js';

export const HCI_SNAPSHOT_SURFACE_OBSERVATION_IDS = ['obs-volumes', 'obs-servers', 'obs-images'] as const;

export type EngineerAssessmentScopeFailure = {
  readonly ok: false;
  readonly code:
    | 'MIXED_CASE_REVISION'
    | 'CROSS_CASE_REF'
    | 'DELETED_REQUIREMENT_REUSED'
    | 'LIVE_OBSERVED_UNBOUND'
    | 'WRONG_PRODUCT'
    | 'WRONG_FIRMWARE';
  readonly message: string;
  readonly guideReadyGranted: false;
};

export type EngineerAssessmentScopeSuccess = {
  readonly ok: true;
  readonly guideReadyGranted: false;
};

export function isHciSnapshotSurfaceObservation(id: string): boolean {
  return (HCI_SNAPSHOT_SURFACE_OBSERVATION_IDS as readonly string[]).includes(id);
}

export function isHciRequiredFieldId(id: string): id is HciE03bFieldId {
  return (HCI_E03B_FIELD_IDS as readonly string[]).includes(id);
}

export function snapshotObservationIsNotCapabilityRow(
  observationId: string,
  fieldId: string | undefined,
): boolean {
  return Boolean(fieldId && isHciRequiredFieldId(fieldId) && isHciSnapshotSurfaceObservation(observationId));
}

export function assertLiveObservedBinding(
  observation: EngineerObservation,
  document: EngineerCaseDocument,
  projectId: string,
): EngineerAssessmentScopeSuccess | EngineerAssessmentScopeFailure {
  if (observation.sourceKind !== 'observed') {
    return { ok: true, guideReadyGranted: false };
  }
  if (!observation.factProvenance) {
    return {
      ok: false,
      code: 'LIVE_OBSERVED_UNBOUND',
      message: `LIVE_OBSERVED_UNBOUND:${observation.id}:factProvenance`,
      guideReadyGranted: false,
    };
  }
  const bound = bindObservedFactToCase(observation.factProvenance, {
    caseId: document.caseId,
    projectId,
    observationId: observation.id,
    environmentKind: document.environmentKind,
    originalPresent: document.originalPresent === true,
  });
  if (!bound.ok) {
    return {
      ok: false,
      code: 'LIVE_OBSERVED_UNBOUND',
      message: `LIVE_OBSERVED_UNBOUND:${observation.id}:${bound.reason}`,
      guideReadyGranted: false,
    };
  }
  return { ok: true, guideReadyGranted: false };
}

export function assertEngineerAssessmentScope(input: {
  readonly document: EngineerCaseDocument;
  readonly caseRevision: string;
  readonly expectedProduct?: EngineerCaseDocument['product'];
  readonly expectedFirmware?: string;
  readonly companionRevisions?: readonly string[];
  readonly priorAssessments?: readonly EngineerAssessment[];
  readonly projectId: string;
}): EngineerAssessmentScopeSuccess | EngineerAssessmentScopeFailure {
  const document = input.document;
  if (input.caseRevision !== document.revision) {
    return {
      ok: false,
      code: 'MIXED_CASE_REVISION',
      message: `MIXED_CASE_REVISION:${input.caseRevision}!=${document.revision}`,
      guideReadyGranted: false,
    };
  }
  if (input.companionRevisions?.some((revision) => revision !== document.revision)) {
    return {
      ok: false,
      code: 'MIXED_CASE_REVISION',
      message: `MIXED_CASE_REVISION:companion:${input.companionRevisions.join(',')}`,
      guideReadyGranted: false,
    };
  }
  if (input.expectedProduct && input.expectedProduct !== document.product) {
    return {
      ok: false,
      code: 'WRONG_PRODUCT',
      message: `WRONG_PRODUCT:${document.product}!=${input.expectedProduct}`,
      guideReadyGranted: false,
    };
  }
  if (input.expectedFirmware && document.firmware && input.expectedFirmware !== document.firmware) {
    return {
      ok: false,
      code: 'WRONG_FIRMWARE',
      message: `WRONG_FIRMWARE:${document.firmware}!=${input.expectedFirmware}`,
      guideReadyGranted: false,
    };
  }

  const currentRequirementIds = new Set(document.requirements.map((item) => item.id));
  const reused = (input.priorAssessments ?? []).filter((item) => !currentRequirementIds.has(item.requirementRef));
  if (reused.length > 0) {
    return {
      ok: false,
      code: 'DELETED_REQUIREMENT_REUSED',
      message: `DELETED_REQUIREMENT_REUSED:${reused.map((item) => item.requirementRef).join(',')}`,
      guideReadyGranted: false,
    };
  }

  const collections = [
    ...document.observations,
    ...document.requirements,
    ...document.calculations,
    ...document.assessments,
  ];
  for (const item of collections) {
    if (item.caseId && item.caseId !== document.caseId) {
      return {
        ok: false,
        code: 'CROSS_CASE_REF',
        message: `CROSS_CASE_REF:${item.caseId}`,
        guideReadyGranted: false,
      };
    }
  }

  for (const observation of document.observations) {
    const live = assertLiveObservedBinding(observation, document, input.projectId);
    if (!live.ok) return live;
    const firmware = observation.factProvenance?.firmwareVersion;
    if (firmware && document.firmware && firmware !== document.firmware) {
      return {
        ok: false,
        code: 'WRONG_FIRMWARE',
        message: `WRONG_FIRMWARE:${observation.id}:${firmware}!=${document.firmware}`,
        guideReadyGranted: false,
      };
    }
  }

  return { ok: true, guideReadyGranted: false };
}
