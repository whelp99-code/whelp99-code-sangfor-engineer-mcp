/**
 * Fail-closed field-acceptance recording for E12.
 *
 * `field_accepted` is not a document claim, not a fixture/e2e/Word result, and
 * not an execution-gate flag. This increment has no live read, so the only
 * honest grant path is none. Unknown stays unknown. This module does not
 * collect, mutate, or persist.
 */

export const ENGINEER_FIELD_ACCEPTANCE_GRANT_KIND = 'pm_live_read_review' as const;

export const ENGINEER_REQUIRED_LIVE_READ_SURFACES = [
  { id: 'volumes', layer: 'E03A', acquisition: 'automatic-when-live' },
  { id: 'servers', layer: 'E03A', acquisition: 'automatic-when-live' },
  { id: 'images', layer: 'E03A', acquisition: 'automatic-when-live' },
  { id: 'collectedAt', layer: 'E03A', acquisition: 'automatic-when-live' },
  { id: 'volume_status_health', layer: 'E03A', acquisition: 'derived-from-live-volumes' },
  { id: 'firmware', layer: 'E03A', acquisition: 'live-or-unknown' },
  { id: 'host_cpu', layer: 'E03B', acquisition: 'unsupported-until-official-read' },
  { id: 'host_ram', layer: 'E03B', acquisition: 'unsupported-until-official-read' },
  { id: 'storage_usable_capacity', layer: 'E03B', acquisition: 'unsupported-until-official-read' },
  { id: 'network_topology', layer: 'E03B', acquisition: 'unsupported-until-official-read' },
  { id: 'ha_status', layer: 'E03B', acquisition: 'unsupported-until-official-read' },
] as const;

export type EngineerRequiredLiveReadSurfaceId =
  (typeof ENGINEER_REQUIRED_LIVE_READ_SURFACES)[number]['id'];

export type EngineerFieldAcceptanceEnvironment = 'fixture' | 'historical_record' | 'live';
export type EngineerFieldAcceptanceReadiness = 'draft' | 'blocked' | 'review_ready';

export type EngineerPmLiveReadAttestation = {
  readonly actorId?: string;
  readonly decision?: string;
  readonly liveCollectStatus?: string;
};

export type EngineerFieldAcceptanceInput = {
  readonly environmentKind?: EngineerFieldAcceptanceEnvironment;
  readonly synthetic?: boolean;
  readonly originalPresent?: boolean;
  readonly guideReadiness?: EngineerFieldAcceptanceReadiness;
  readonly wordExportOk?: boolean;
  readonly workflowCompletedNormally?: boolean;
  readonly developerTestPass?: boolean;
  readonly liveProof?: boolean;
  readonly claimedFieldAccepted?: boolean;
  readonly grantKind?: string;
  readonly pmAttestation?: EngineerPmLiveReadAttestation;
  readonly allowRealExecution?: boolean;
};

export type EngineerLiveReadSurfaceStatus = {
  readonly id: EngineerRequiredLiveReadSurfaceId;
  readonly layer: 'E03A' | 'E03B';
  readonly acquisition: (typeof ENGINEER_REQUIRED_LIVE_READ_SURFACES)[number]['acquisition'];
  readonly status: 'NOT_RUN';
};

export type EngineerFieldAcceptanceDecision = {
  readonly fieldAccepted: false;
  readonly grantPath: 'none';
  readonly liveRead: 'not_run';
  readonly reasonCode: string;
  readonly refusedReasons: readonly string[];
  readonly requiredLiveSurfaces: readonly EngineerLiveReadSurfaceStatus[];
  readonly mutationDispatchCount: 0;
};

function uniqueReasons(reasons: readonly string[]): string[] {
  return [...new Set(reasons)];
}

export function evaluateEngineerFieldAcceptance(
  input: EngineerFieldAcceptanceInput = {},
): EngineerFieldAcceptanceDecision {
  const refused: string[] = [];

  if (input.environmentKind === 'fixture' || input.synthetic === true) {
    refused.push('FIXTURE_IS_NOT_FIELD_ACCEPTED');
  }
  if (input.environmentKind === 'historical_record') {
    refused.push('HISTORICAL_RECORD_IS_NOT_CURRENT_LIVE');
  }
  if (input.guideReadiness === 'review_ready') {
    refused.push('REVIEW_READY_IS_NOT_FIELD_ACCEPTED');
  }
  if (input.wordExportOk === true) {
    refused.push('WORD_DOWNLOAD_IS_NOT_FIELD_ACCEPTED');
  }
  if (input.workflowCompletedNormally === true) {
    refused.push('WORKFLOW_PASS_IS_NOT_FIELD_ACCEPTED');
  }
  if (input.developerTestPass === true) {
    refused.push('DEVELOPER_TEST_IS_NOT_FIELD_ACCEPTED');
  }
  if (input.liveProof === true) {
    refused.push('CLAIMED_LIVE_PROOF_IS_NOT_A_LIVE_READ');
  }
  if (input.claimedFieldAccepted === true) {
    refused.push('CLAIMED_FIELD_ACCEPTED_IS_NOT_A_GRANT');
  }
  if (input.allowRealExecution === true) {
    refused.push('EXECUTION_FLAG_IS_NOT_FIELD_ACCEPTANCE');
  }
  if (input.grantKind !== undefined && input.grantKind !== ENGINEER_FIELD_ACCEPTANCE_GRANT_KIND) {
    refused.push('UNKNOWN_FIELD_ACCEPTANCE_GRANT_KIND');
  }
  if (input.grantKind !== ENGINEER_FIELD_ACCEPTANCE_GRANT_KIND) {
    refused.push('PM_LIVE_READ_REVIEW_REQUIRED');
  }
  if (input.pmAttestation?.decision !== 'accept_after_live_read') {
    refused.push('PM_ATTESTATION_REQUIRED');
  }
  if (input.pmAttestation?.liveCollectStatus === 'ran') {
    refused.push('ATTESTED_LIVE_COLLECT_WITHOUT_IN_PROCESS_READ');
  }
  refused.push('LIVE_READ_NOT_RUN');

  const refusedReasons = uniqueReasons(refused);
  return {
    fieldAccepted: false,
    grantPath: 'none',
    liveRead: 'not_run',
    reasonCode: refusedReasons[0] ?? 'FIELD_ACCEPTED_REQUIRES_PM_LIVE_READ',
    refusedReasons,
    requiredLiveSurfaces: ENGINEER_REQUIRED_LIVE_READ_SURFACES.map((surface) => ({
      id: surface.id,
      layer: surface.layer,
      acquisition: surface.acquisition,
      status: 'NOT_RUN',
    })),
    mutationDispatchCount: 0,
  };
}
