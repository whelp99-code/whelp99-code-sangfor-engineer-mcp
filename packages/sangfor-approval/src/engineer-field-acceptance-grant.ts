/**
 * Honest E12 field-acceptance grant recorder.
 *
 * Reuses `@sangfor/approval` HMAC primitives (`canonicalizeApprovalPayload`,
 * `signDomainApproval`, `verifyDomainApprovalSignature`) and the existing
 * single-use nonce store. This is not a new MAC scheme and not a device-write
 * approval. The operator execution secret is never used. Production reads
 * `SANGFOR_ENGINEER_FIELD_ACCEPTANCE_SECRET` from the environment only.
 *
 * A grant requires the conjunction of bound live originalPresent facts
 * (recomputed through `bindObservedFactToCase`), a signature over that
 * observation digest plus matching case/guide revisions, and a consumed
 * single-use nonce. Caller-chosen live labels are not proof.
 */

import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  resolveProductionLocalWriteAuthority,
  resolveRepoData,
} from '@sangfor/shared';
import {
  ENGINEER_FIELD_ACCEPTANCE_APPROVAL_DOMAIN,
  ENGINEER_FIELD_ACCEPTANCE_GRANT_KIND,
  ENGINEER_FIELD_ACCEPTANCE_SECRET_ENV,
  collectEngineerFieldAcceptanceRefusals,
  type EngineerBoundObservationInput,
  type EngineerFieldAcceptanceDecision,
  type EngineerFieldAcceptanceGranted,
  type EngineerFieldAcceptanceInput,
  type EngineerFieldAcceptanceLiveReadStatus,
  type EngineerFieldAcceptanceRefusal,
  type EngineerLiveReadEvidence,
  type EngineerLiveReadSurfaceStatus,
  type EngineerPmLiveReadGrant,
} from '../../shared/src/engineer-field-acceptance.js';
import {
  digestEngineerBoundObservations,
  rebindEngineerFieldAcceptanceObservations,
  requiredSurfacesMissingBoundFacts,
  surfacesFromBoundObservations,
} from '../../sangfor-config-state/src/engineer-field-acceptance-bind.js';
import {
  FileSingleUseNonceStore,
  canonicalizeApprovalPayload,
  hasApprovalControlCharacters,
  signDomainApproval,
  verifyDomainApprovalSignature,
} from './index.js';

const TOKEN = /^[a-f0-9]{64}$/u;
const GRANT_TTL_MS = 60 * 60 * 1000;

const INSUFFICIENT_ALONE = new Set([
  'REVIEW_READY_IS_NOT_FIELD_ACCEPTED',
  'WORD_DOWNLOAD_IS_NOT_FIELD_ACCEPTED',
  'WORKFLOW_PASS_IS_NOT_FIELD_ACCEPTED',
  'DEVELOPER_TEST_IS_NOT_FIELD_ACCEPTED',
  'PM_LIVE_READ_REVIEW_REQUIRED',
  'PM_ATTESTATION_REQUIRED',
  'LIVE_READ_NOT_RUN',
  'ATTESTATION_STRING_IS_NOT_A_GRANT',
  'ATTESTED_LIVE_COLLECT_WITHOUT_IN_PROCESS_READ',
]);

export type EngineerFieldAcceptanceGrantInput = EngineerFieldAcceptanceInput & {
  readonly now?: Date;
};

function uniqueReasons(reasons: readonly string[]): string[] {
  return [...new Set(reasons)];
}

function refuse(
  reasons: readonly string[],
  liveRead: EngineerFieldAcceptanceLiveReadStatus,
  requiredLiveSurfaces: readonly EngineerLiveReadSurfaceStatus[],
): EngineerFieldAcceptanceRefusal {
  const refusedReasons = uniqueReasons(reasons);
  return {
    fieldAccepted: false,
    grantPath: 'none',
    liveRead,
    reasonCode: refusedReasons[0] ?? 'FIELD_ACCEPTED_REQUIRES_PM_LIVE_READ',
    refusedReasons,
    requiredLiveSurfaces,
    mutationDispatchCount: 0,
  };
}

function resolveGrantSecret(): string | undefined {
  const value = process.env[ENGINEER_FIELD_ACCEPTANCE_SECRET_ENV];
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  return value;
}

export function canonicalizeEngineerPmLiveReadGrant(input: {
  readonly grant: Omit<EngineerPmLiveReadGrant, 'approvalToken'>;
  readonly observationDigest: string;
}): string {
  return canonicalizeApprovalPayload([
    ENGINEER_FIELD_ACCEPTANCE_APPROVAL_DOMAIN,
    ENGINEER_FIELD_ACCEPTANCE_GRANT_KIND,
    input.grant.approvedBy,
    input.grant.decision,
    input.grant.caseId,
    input.grant.caseRevision,
    input.grant.guideRevision,
    input.observationDigest,
    input.grant.nonce,
    input.grant.expiresAt,
  ]);
}

export function signEngineerPmLiveReadGrant(input: {
  readonly approvedBy: string;
  readonly caseId: string;
  readonly caseRevision: string;
  readonly guideRevision: string;
  readonly boundObservations: readonly EngineerBoundObservationInput[];
  readonly nonce?: string;
  readonly expiresAt?: string;
  readonly now?: Date;
}): EngineerPmLiveReadGrant {
  const secret = resolveGrantSecret();
  if (secret === undefined) {
    throw new Error('FIELD_ACCEPTANCE_SECRET_MISSING');
  }
  const { bound, failed } = rebindEngineerFieldAcceptanceObservations(input.boundObservations);
  if (failed.length > 0 || bound.length === 0) {
    throw new Error('OBSERVATION_DIGEST_REQUIRED');
  }
  const observationDigest = digestEngineerBoundObservations(bound);
  const now = input.now ?? new Date();
  const grant: Omit<EngineerPmLiveReadGrant, 'approvalToken'> = {
    approvedBy: input.approvedBy,
    decision: 'accept_after_live_read',
    caseId: input.caseId,
    caseRevision: input.caseRevision,
    guideRevision: input.guideRevision,
    nonce: input.nonce ?? randomUUID(),
    expiresAt: input.expiresAt ?? new Date(now.getTime() + GRANT_TTL_MS).toISOString(),
  };
  const canonical = canonicalizeEngineerPmLiveReadGrant({ grant, observationDigest });
  return {
    ...grant,
    approvalToken: Buffer.from(signDomainApproval(secret, canonical)).toString('hex'),
  };
}

function liveReadRefusals(liveRead: EngineerLiveReadEvidence): string[] {
  const refused: string[] = [];
  if (
    liveRead.synthetic === true
    || liveRead.environmentKind === 'fixture'
    || liveRead.sourceKind === 'fixture'
  ) {
    refused.push('FIXTURE_IS_NOT_FIELD_ACCEPTED');
    refused.push('SYNTHETIC_LIVE_SHAPED_FIXTURE_IS_NOT_LIVE');
  }
  if (liveRead.environmentKind === 'historical_record' || liveRead.sourceKind === 'historical_record') {
    refused.push('HISTORICAL_RECORD_IS_NOT_CURRENT_LIVE');
  }
  if (liveRead.sourceKind === 'mock_console') {
    refused.push('MOCK_CONSOLE_IS_NOT_FIELD_ACCEPTED');
  }
  if (liveRead.sourceKind === 'attestation') {
    refused.push('ATTESTATION_STRING_IS_NOT_A_GRANT');
  }
  if (liveRead.executed !== true) {
    refused.push('LIVE_READ_NOT_EXECUTED');
  }
  if (liveRead.originalPresent !== true) {
    refused.push('LIVE_READ_ORIGINAL_ABSENT');
  }
  return refused;
}

function verifyStructuredGrant(input: {
  readonly secret: string | undefined;
  readonly grant: EngineerPmLiveReadGrant;
  readonly observationDigest: string | undefined;
  readonly now: Date;
}): string[] {
  const refused: string[] = [];
  if (input.secret === undefined) {
    refused.push('FIELD_ACCEPTANCE_SECRET_MISSING');
    return refused;
  }
  if (input.observationDigest === undefined) {
    refused.push('OBSERVATION_DIGEST_REQUIRED');
    return refused;
  }
  const required = [
    input.grant.approvedBy,
    input.grant.decision,
    input.grant.caseId,
    input.grant.caseRevision,
    input.grant.guideRevision,
    input.grant.nonce,
    input.grant.expiresAt,
    input.grant.approvalToken,
  ];
  if (required.some((field) => typeof field !== 'string' || field.length === 0)) {
    refused.push('PM_GRANT_FIELDS_MISSING');
    return refused;
  }
  if (required.some(hasApprovalControlCharacters)) {
    refused.push('PM_GRANT_INVALID_FIELDS');
    return refused;
  }
  if (input.grant.decision !== 'accept_after_live_read') {
    refused.push('PM_ATTESTATION_REQUIRED');
  }
  const expiry = Date.parse(input.grant.expiresAt);
  if (!Number.isFinite(expiry)) {
    refused.push('PM_GRANT_INVALID_EXPIRY');
    return refused;
  }
  if (input.now.getTime() > expiry) {
    refused.push('PM_GRANT_EXPIRED');
    return refused;
  }
  if (!TOKEN.test(input.grant.approvalToken)) {
    refused.push('PM_GRANT_SIGNATURE_MISMATCH');
    return refused;
  }
  let canonical: string;
  try {
    canonical = canonicalizeEngineerPmLiveReadGrant({
      grant: input.grant,
      observationDigest: input.observationDigest,
    });
  } catch {
    refused.push('PM_GRANT_INVALID_FIELDS');
    return refused;
  }
  const verdict = verifyDomainApprovalSignature(
    input.secret,
    canonical,
    Buffer.from(input.grant.approvalToken, 'hex'),
  );
  if (!verdict.ok) refused.push('PM_GRANT_SIGNATURE_MISMATCH');
  return refused;
}

function revisionConflict(input: EngineerFieldAcceptanceGrantInput): boolean {
  const live = input.liveRead;
  const grant = input.pmGrant;
  const caseRevision = input.caseRevision;
  const guideRevision = input.guideRevision;
  if (live && caseRevision !== undefined && live.caseRevision !== caseRevision) return true;
  if (live && guideRevision !== undefined && live.guideRevision !== guideRevision) return true;
  if (grant && caseRevision !== undefined && grant.caseRevision !== caseRevision) return true;
  if (grant && guideRevision !== undefined && grant.guideRevision !== guideRevision) return true;
  if (live && grant && live.caseRevision !== grant.caseRevision) return true;
  if (live && grant && live.guideRevision !== grant.guideRevision) return true;
  if (live && grant && input.caseId !== undefined && grant.caseId !== input.caseId) return true;
  return false;
}

function defaultNonceStorePath(): string {
  return process.env.SANGFOR_NONCE_STORE_PATH
    ?? join(resolveRepoData('data/runtime'), 'approval-nonces.json');
}

function fieldAcceptanceNonceStore(): FileSingleUseNonceStore {
  const selected = process.env.SANGFOR_NONCE_STORE?.trim();
  if (selected !== undefined && selected !== '' && selected !== 'file') {
    throw new Error('FIELD_ACCEPTANCE_NONCE_STORE_UNAVAILABLE');
  }
  const filePath = defaultNonceStorePath();
  return new FileSingleUseNonceStore(filePath, resolveProductionLocalWriteAuthority({
    tenantId: 'local-primary',
    projectId: process.env.SANGFOR_ENGAGEMENT_ID ?? 'local-primary',
    actorId: 'local-primary',
    aggregate: 'approvals_nonces',
    sourceRoot: dirname(filePath),
  }));
}

async function consumeFieldAcceptanceNonce(input: {
  readonly nonce: string;
  readonly expiresAt: string;
  readonly now: Date;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const store = fieldAcceptanceNonceStore();
    const consumed = await store.consume(input.nonce, input.expiresAt, input.now);
    if (consumed.ok) return { ok: true };
    if (consumed.reason?.startsWith('approval nonce already used:')) {
      return { ok: false, reason: 'FIELD_ACCEPTANCE_NONCE_ALREADY_USED' };
    }
    return { ok: false, reason: 'FIELD_ACCEPTANCE_NONCE_STORE_UNAVAILABLE' };
  } catch {
    return { ok: false, reason: 'FIELD_ACCEPTANCE_NONCE_STORE_UNAVAILABLE' };
  }
}

function resolveLiveReadStatus(input: {
  readonly claimed: boolean;
  readonly boundOk: boolean;
  readonly granted: boolean;
}): EngineerFieldAcceptanceLiveReadStatus {
  if (input.granted || input.boundOk) return 'executed';
  if (input.claimed) return 'refused';
  return 'not_run';
}

/**
 * Production grant evaluator. Default is refuse. `fieldAccepted: true` only
 * after bound live originalPresent facts, a domain-HMAC PM grant over the
 * observation digest, matching revisions, and a consumed nonce. This function
 * never reads a caller-supplied secret and never treats fixture labels as live.
 */
export async function evaluateEngineerFieldAcceptanceGrant(
  input: EngineerFieldAcceptanceGrantInput = {},
): Promise<EngineerFieldAcceptanceDecision> {
  const baseReasons = collectEngineerFieldAcceptanceRefusals(input);
  const rebound = rebindEngineerFieldAcceptanceObservations(input.boundObservations ?? []);
  const surfaces = surfacesFromBoundObservations(rebound.bound);
  const missingSurfaces = requiredSurfacesMissingBoundFacts(rebound.bound);
  const observationDigest = rebound.bound.length > 0
    ? digestEngineerBoundObservations(rebound.bound)
    : undefined;
  const boundOk = rebound.failed.length === 0
    && missingSurfaces.length === 0
    && observationDigest !== undefined;
  const claimedLive = input.liveRead !== undefined || (input.boundObservations?.length ?? 0) > 0;

  if (input.liveRead === undefined && input.pmGrant === undefined && input.boundObservations === undefined) {
    return refuse(baseReasons, 'not_run', surfaces);
  }

  const extra: string[] = [];

  if (input.liveRead !== undefined) {
    extra.push(...liveReadRefusals(input.liveRead));
    if (input.liveRead.sourceKind === 'authorized_device_read' && !boundOk) {
      extra.push('CLAIMED_AUTHORIZED_DEVICE_READ_WITHOUT_BOUND_FACTS');
    }
  }

  if (rebound.failed.length > 0 || observationDigest === undefined) {
    extra.push('OBSERVATION_DIGEST_REQUIRED');
    extra.push('LIVE_BOUND_FACTS_REQUIRED');
  }
  if (missingSurfaces.length > 0) {
    extra.push('REQUIRED_LIVE_SURFACES_NOT_RUN');
  }

  if (revisionConflict(input)) extra.push('REVISION_CONFLICT');

  if (input.pmGrant === undefined) {
    extra.push('PM_GRANT_SIGNATURE_REQUIRED');
  } else {
    extra.push(...verifyStructuredGrant({
      secret: resolveGrantSecret(),
      grant: input.pmGrant,
      observationDigest,
      now: input.now ?? new Date(),
    }));
  }

  const merged = uniqueReasons([...baseReasons, ...extra]);
  const hard = merged.filter((reason) => !INSUFFICIENT_ALONE.has(reason));
  const mayGrant = boundOk
    && hard.length === 0
    && input.environmentKind === 'live'
    && input.synthetic !== true
    && input.originalPresent === true
    && input.liveProof !== true
    && input.claimedFieldAccepted !== true
    && input.allowRealExecution !== true
    && input.pmGrant !== undefined;

  if (!mayGrant) {
    return refuse(
      merged,
      resolveLiveReadStatus({ claimed: claimedLive, boundOk, granted: false }),
      surfaces,
    );
  }

  const consumed = await consumeFieldAcceptanceNonce({
    nonce: input.pmGrant.nonce,
    expiresAt: input.pmGrant.expiresAt,
    now: input.now ?? new Date(),
  });
  if (!consumed.ok) {
    return refuse(
      [...merged, consumed.reason],
      resolveLiveReadStatus({ claimed: claimedLive, boundOk, granted: false }),
      surfaces,
    );
  }

  const granted: EngineerFieldAcceptanceGranted = {
    fieldAccepted: true,
    grantPath: ENGINEER_FIELD_ACCEPTANCE_GRANT_KIND,
    liveRead: 'executed',
    reasonCode: 'PM_LIVE_READ_REVIEW_GRANTED',
    refusedReasons: [],
    requiredLiveSurfaces: surfaces,
    mutationDispatchCount: 0,
  };
  return granted;
}
