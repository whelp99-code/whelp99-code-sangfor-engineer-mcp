/**
 * Test-only helper for the E12 grant conjunction.
 *
 * THIS IS NOT A PRODUCTION DEFAULT. Production
 * `evaluateEngineerFieldAcceptanceGrant` reads
 * `SANGFOR_ENGINEER_FIELD_ACCEPTANCE_SECRET` and never this constant.
 * The helper exists so unit tests can prove the honest grant path without a
 * device. It still goes through the real `@sangfor/approval` HMAC signer.
 */

import {
  evaluateEngineerFieldAcceptanceGrant,
  signEngineerPmLiveReadGrant,
} from '../../packages/sangfor-approval/src/engineer-field-acceptance-grant.js';
import type {
  EngineerFieldAcceptanceDecision,
  EngineerLiveReadEvidence,
} from '../../packages/shared/src/engineer-field-acceptance.js';

export const ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_SECRET =
  'sangfor-e12-field-acceptance-test-double-not-for-production';

export const ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_CASE_ID = 'e12-test-double-case';
export const ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_CASE_REVISION = 'rev-case-test-double';
export const ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_GUIDE_REVISION = 'rev-guide-test-double';

export function engineerFieldAcceptanceTestDoubleLiveRead(
  overrides: Partial<EngineerLiveReadEvidence> = {},
): EngineerLiveReadEvidence {
  return {
    executed: true,
    environmentKind: 'live',
    originalPresent: true,
    synthetic: false,
    sourceKind: 'authorized_device_read',
    caseRevision: ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_CASE_REVISION,
    guideRevision: ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_GUIDE_REVISION,
    ...overrides,
  };
}

export function evaluateEngineerFieldAcceptanceTestDouble(
  now = new Date('2026-09-10T00:00:00.000Z'),
): EngineerFieldAcceptanceDecision {
  const liveRead = engineerFieldAcceptanceTestDoubleLiveRead();
  const pmGrant = signEngineerPmLiveReadGrant({
    secret: ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_SECRET,
    approvedBy: 'pm-test-double',
    caseId: ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_CASE_ID,
    caseRevision: liveRead.caseRevision,
    guideRevision: liveRead.guideRevision,
    liveRead,
    nonce: 'e12-test-double-nonce',
    expiresAt: '2026-09-10T01:00:00.000Z',
    now,
  });
  return evaluateEngineerFieldAcceptanceGrant({
    environmentKind: 'live',
    synthetic: false,
    originalPresent: true,
    caseId: ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_CASE_ID,
    caseRevision: liveRead.caseRevision,
    guideRevision: liveRead.guideRevision,
    liveRead,
    pmGrant,
    secret: ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_SECRET,
    now,
  });
}
