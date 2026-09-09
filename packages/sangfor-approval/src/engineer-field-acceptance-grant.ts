/**
 * Honest E12 field-acceptance grant recorder.
 *
 * Reuses `@sangfor/approval` HMAC primitives (`canonicalizeApprovalPayload`,
 * `signDomainApproval`, `verifyDomainApprovalSignature`). This is not a new
 * MAC scheme and not a device-write approval. The operator execution secret
 * is never used. Missing `SANGFOR_ENGINEER_FIELD_ACCEPTANCE_SECRET` fails closed.
 *
 * A grant requires the conjunction of a structurally valid live read
 * (`originalPresent`, authorized device, not fixture/mock) and a signature
 * bound to that live digest plus matching case/guide revisions.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  ENGINEER_FIELD_ACCEPTANCE_APPROVAL_DOMAIN,
  ENGINEER_FIELD_ACCEPTANCE_GRANT_KIND,
  ENGINEER_FIELD_ACCEPTANCE_SECRET_ENV,
  ENGINEER_REQUIRED_LIVE_READ_SURFACES,
  collectEngineerFieldAcceptanceRefusals,
  type EngineerFieldAcceptanceDecision,
  type EngineerFieldAcceptanceInput,
  type EngineerFieldAcceptanceLiveReadStatus,
  type EngineerLiveReadEvidence,
  type EngineerLiveReadSurfaceStatus,
  type EngineerPmLiveReadGrant,
} from '../../shared/src/engineer-field-acceptance.js';
import {
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
  readonly secret?: string;
  readonly now?: Date;
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

function refuse(
  reasons: readonly string[],
  liveRead: EngineerFieldAcceptanceLiveReadStatus,
): EngineerFieldAcceptanceDecision {
  const refusedReasons = uniqueReasons(reasons);
  return {
    fieldAccepted: false,
    grantPath: 'none',
    liveRead,
    reasonCode: refusedReasons[0] ?? 'FIELD_ACCEPTED_REQUIRES_PM_LIVE_READ',
    refusedReasons,
    requiredLiveSurfaces: notRunSurfaces(),
    mutationDispatchCount: 0,
  };
}

export function digestEngineerLiveReadEvidence(liveRead: EngineerLiveReadEvidence): string {
  return createHash('sha256')
    .update(canonicalizeApprovalPayload([
      liveRead.environmentKind,
      liveRead.executed ? '1' : '0',
      liveRead.originalPresent ? '1' : '0',
      liveRead.synthetic ? '1' : '0',
      liveRead.sourceKind,
      liveRead.caseRevision,
      liveRead.guideRevision,
    ]), 'utf8')
    .digest('hex');
}

export function canonicalizeEngineerPmLiveReadGrant(input: {
  readonly grant: Omit<EngineerPmLiveReadGrant, 'approvalToken'>;
  readonly liveRead: EngineerLiveReadEvidence;
}): string {
  return canonicalizeApprovalPayload([
    ENGINEER_FIELD_ACCEPTANCE_APPROVAL_DOMAIN,
    ENGINEER_FIELD_ACCEPTANCE_GRANT_KIND,
    input.grant.approvedBy,
    input.grant.decision,
    input.grant.caseId,
    input.grant.caseRevision,
    input.grant.guideRevision,
    digestEngineerLiveReadEvidence(input.liveRead),
    input.grant.nonce,
    input.grant.expiresAt,
  ]);
}

function resolveGrantSecret(explicit?: string): string | undefined {
  const value = explicit ?? process.env[ENGINEER_FIELD_ACCEPTANCE_SECRET_ENV];
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  return value;
}

export function signEngineerPmLiveReadGrant(input: {
  readonly secret: string;
  readonly approvedBy: string;
  readonly caseId: string;
  readonly caseRevision: string;
  readonly guideRevision: string;
  readonly liveRead: EngineerLiveReadEvidence;
  readonly nonce?: string;
  readonly expiresAt?: string;
  readonly now?: Date;
}): EngineerPmLiveReadGrant {
  if (typeof input.secret !== 'string' || input.secret.trim().length === 0) {
    throw new Error('FIELD_ACCEPTANCE_SECRET_MISSING');
  }
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
  const canonical = canonicalizeEngineerPmLiveReadGrant({ grant, liveRead: input.liveRead });
  return {
    ...grant,
    approvalToken: Buffer.from(signDomainApproval(input.secret, canonical)).toString('hex'),
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
  if (liveRead.environmentKind !== 'live' || liveRead.sourceKind !== 'authorized_device_read') {
    refused.push('LIVE_READ_SOURCE_NOT_AUTHORIZED_DEVICE');
  }
  return refused;
}

function isStructurallyValidLiveRead(liveRead: EngineerLiveReadEvidence): boolean {
  return liveRead.executed === true
    && liveRead.originalPresent === true
    && liveRead.synthetic !== true
    && liveRead.environmentKind === 'live'
    && liveRead.sourceKind === 'authorized_device_read';
}

function verifyStructuredGrant(input: {
  readonly secret: string | undefined;
  readonly grant: EngineerPmLiveReadGrant;
  readonly liveRead: EngineerLiveReadEvidence;
  readonly now: Date;
}): string[] {
  const refused: string[] = [];
  if (input.secret === undefined) {
    refused.push('FIELD_ACCEPTANCE_SECRET_MISSING');
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
      liveRead: input.liveRead,
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

/**
 * Production grant evaluator. Default is refuse. `fieldAccepted: true` only
 * after a structurally valid live originalPresent read and a domain-HMAC PM
 * grant over the same revisions. This function has no production test-double
 * default and never reads a fixture as live.
 */
export function evaluateEngineerFieldAcceptanceGrant(
  input: EngineerFieldAcceptanceGrantInput = {},
): EngineerFieldAcceptanceDecision {
  const baseReasons = collectEngineerFieldAcceptanceRefusals(input);
  if (input.liveRead === undefined && input.pmGrant === undefined) {
    return refuse(baseReasons, 'not_run');
  }

  const extra: string[] = [];
  let liveReadStatus: EngineerFieldAcceptanceLiveReadStatus = 'not_run';

  if (input.liveRead !== undefined) {
    extra.push(...liveReadRefusals(input.liveRead));
    liveReadStatus = isStructurallyValidLiveRead(input.liveRead) ? 'executed' : 'refused';
  } else {
    extra.push('LIVE_READ_NOT_EXECUTED');
  }

  if (revisionConflict(input)) extra.push('REVISION_CONFLICT');

  if (input.pmGrant === undefined) {
    extra.push('PM_GRANT_SIGNATURE_REQUIRED');
  } else if (input.liveRead === undefined) {
    extra.push('PM_GRANT_SIGNATURE_REQUIRED');
    extra.push('LIVE_READ_NOT_EXECUTED');
  } else {
    extra.push(...verifyStructuredGrant({
      secret: resolveGrantSecret(input.secret),
      grant: input.pmGrant,
      liveRead: input.liveRead,
      now: input.now ?? new Date(),
    }));
  }

  const merged = uniqueReasons([...baseReasons, ...extra]);
  const hard = merged.filter((reason) => !INSUFFICIENT_ALONE.has(reason));
  const liveOk = input.liveRead !== undefined && isStructurallyValidLiveRead(input.liveRead);
  const granted = liveOk
    && hard.length === 0
    && input.environmentKind === 'live'
    && input.synthetic !== true
    && input.originalPresent === true
    && input.liveProof !== true
    && input.claimedFieldAccepted !== true
    && input.allowRealExecution !== true
    && input.pmGrant !== undefined;

  if (!granted) {
    return refuse(merged, liveReadStatus === 'executed' && !liveOk ? 'refused' : liveReadStatus);
  }

  return {
    fieldAccepted: true,
    grantPath: ENGINEER_FIELD_ACCEPTANCE_GRANT_KIND,
    liveRead: 'executed',
    reasonCode: 'PM_LIVE_READ_REVIEW_GRANTED',
    refusedReasons: [],
    requiredLiveSurfaces: notRunSurfaces(),
    mutationDispatchCount: 0,
  };
}
