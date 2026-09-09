/**
 * Fail-closed field-acceptance recording for E12.
 *
 * `field_accepted` is not a document claim, not a fixture/e2e/Word result, and
 * not an execution-gate flag. This module records refusals only. It does not
 * verify HMAC, collect, mutate, or persist. A grant requires the sibling
 * recorder in `@sangfor/approval` plus a live originalPresent read and a
 * structured PM grant. Unknown stays unknown.
 */

export const ENGINEER_FIELD_ACCEPTANCE_GRANT_KIND = 'pm_live_read_review' as const;
export const ENGINEER_FIELD_ACCEPTANCE_APPROVAL_DOMAIN =
  'engineer.field_acceptance.pm_live_read_review.v1' as const;
export const ENGINEER_FIELD_ACCEPTANCE_SECRET_ENV =
  'SANGFOR_ENGINEER_FIELD_ACCEPTANCE_SECRET' as const;

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
export type EngineerFieldAcceptanceGrantPath = 'none' | typeof ENGINEER_FIELD_ACCEPTANCE_GRANT_KIND;
export type EngineerFieldAcceptanceLiveReadStatus = 'not_run' | 'refused' | 'executed';
export type EngineerLiveReadSourceKind =
  | 'authorized_device_read'
  | 'fixture'
  | 'mock_console'
  | 'historical_record'
  | 'attestation';

export type EngineerPmLiveReadAttestation = {
  readonly actorId?: string;
  readonly decision?: string;
  readonly liveCollectStatus?: string;
};

export type EngineerLiveReadEvidence = {
  readonly executed: boolean;
  readonly environmentKind: EngineerFieldAcceptanceEnvironment;
  readonly originalPresent: boolean;
  readonly synthetic: boolean;
  readonly sourceKind: EngineerLiveReadSourceKind;
  readonly caseRevision: string;
  readonly guideRevision: string;
};

export type EngineerPmLiveReadGrant = {
  readonly approvedBy: string;
  readonly decision: 'accept_after_live_read';
  readonly caseId: string;
  readonly caseRevision: string;
  readonly guideRevision: string;
  readonly nonce: string;
  readonly expiresAt: string;
  readonly approvalToken: string;
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
  readonly caseId?: string;
  readonly caseRevision?: string;
  readonly guideRevision?: string;
  readonly liveRead?: EngineerLiveReadEvidence;
  readonly pmGrant?: EngineerPmLiveReadGrant;
};

export type EngineerLiveReadSurfaceStatus = {
  readonly id: EngineerRequiredLiveReadSurfaceId;
  readonly layer: 'E03A' | 'E03B';
  readonly acquisition: (typeof ENGINEER_REQUIRED_LIVE_READ_SURFACES)[number]['acquisition'];
  readonly status: 'NOT_RUN';
};

export type EngineerFieldAcceptanceDecision = {
  readonly fieldAccepted: boolean;
  readonly grantPath: EngineerFieldAcceptanceGrantPath;
  readonly liveRead: EngineerFieldAcceptanceLiveReadStatus;
  readonly reasonCode: string;
  readonly refusedReasons: readonly string[];
  readonly requiredLiveSurfaces: readonly EngineerLiveReadSurfaceStatus[];
  readonly mutationDispatchCount: 0;
};

function uniqueReasons(reasons: readonly string[]): string[] {
  return [...new Set(reasons)];
}

function notRunSurfaces(): EngineerLiveReadSurfaceStatus[] {
  return ENGINEER_REQUIRED_LIVE_READ_SURFACES.map((surface) => ({
    id: surface.id,
    layer: surface.layer,
    acquisition: surface.acquisition,
    status: 'NOT_RUN',
  }));
}

export function collectEngineerFieldAcceptanceRefusals(
  input: EngineerFieldAcceptanceInput = {},
): string[] {
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
  if (input.grantKind === ENGINEER_FIELD_ACCEPTANCE_GRANT_KIND && input.pmGrant === undefined) {
    refused.push('ATTESTATION_STRING_IS_NOT_A_GRANT');
  }
  if (input.pmAttestation?.decision !== 'accept_after_live_read') {
    refused.push('PM_ATTESTATION_REQUIRED');
  }
  if (input.pmAttestation?.liveCollectStatus === 'ran') {
    refused.push('ATTESTED_LIVE_COLLECT_WITHOUT_IN_PROCESS_READ');
  }
  refused.push('LIVE_READ_NOT_RUN');
  return uniqueReasons(refused);
}

export function evaluateEngineerFieldAcceptance(
  input: EngineerFieldAcceptanceInput = {},
): EngineerFieldAcceptanceDecision {
  const refusedReasons = collectEngineerFieldAcceptanceRefusals(input);
  return {
    fieldAccepted: false,
    grantPath: 'none',
    liveRead: 'not_run',
    reasonCode: refusedReasons[0] ?? 'FIELD_ACCEPTED_REQUIRES_PM_LIVE_READ',
    refusedReasons,
    requiredLiveSurfaces: notRunSurfaces(),
    mutationDispatchCount: 0,
  };
}
