/**
 * Test-only helper for the E12 grant conjunction.
 *
 * THIS IS NOT A PRODUCTION DEFAULT and not field_accepted for a real case.
 * Production `evaluateEngineerFieldAcceptanceGrant` reads
 * `SANGFOR_ENGINEER_FIELD_ACCEPTANCE_SECRET` from the environment and never
 * this constant. Tests inject that secret only through this harness.
 *
 * Live-shaped four-flag objects are still available so tests can prove they
 * do not grant. The sibling true path goes through `bindObservedFactToCase`
 * via `bindEngineerAuthorizedDeviceReadEvidence`. That is a binder-path unit
 * fixture, not a live HCI collect and not invented device inventory.
 */

import { MAPPER_VERSION } from '../../packages/sangfor-config-state/src/provenance.js';
import { bindEngineerAuthorizedDeviceReadEvidence } from '../../packages/sangfor-config-state/src/engineer-field-acceptance-bind.js';
import {
  evaluateEngineerFieldAcceptanceGrant,
  signEngineerPmLiveReadGrant,
} from '../../packages/sangfor-approval/src/engineer-field-acceptance-grant.js';
import {
  ENGINEER_FIELD_ACCEPTANCE_SECRET_ENV,
  ENGINEER_REQUIRED_LIVE_READ_SURFACES,
  type EngineerBoundObservationInput,
  type EngineerFieldAcceptanceDecision,
  type EngineerLiveReadEvidence,
} from '../../packages/shared/src/engineer-field-acceptance.js';

export const ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_SECRET =
  'sangfor-e12-field-acceptance-test-double-not-for-production';

export const ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_CASE_ID = 'e12-test-double-case';
export const ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_PROJECT_ID = 'e12-test-double-project';
export const ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_CASE_REVISION = 'rev-case-test-double';
export const ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_GUIDE_REVISION = 'rev-guide-test-double';
export const ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_NONCE = 'e12-test-double-nonce';

export async function withEngineerFieldAcceptanceTestSecret<T>(run: () => T | Promise<T>): Promise<T> {
  const previous = process.env[ENGINEER_FIELD_ACCEPTANCE_SECRET_ENV];
  process.env[ENGINEER_FIELD_ACCEPTANCE_SECRET_ENV] = ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_SECRET;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env[ENGINEER_FIELD_ACCEPTANCE_SECRET_ENV];
    else process.env[ENGINEER_FIELD_ACCEPTANCE_SECRET_ENV] = previous;
  }
}

/**
 * Caller-built live-shaped labels. Not a collect binder result.
 * Must not be enough to grant.
 */
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

export function engineerFieldAcceptanceTestDoubleBoundObservations(): EngineerBoundObservationInput[] {
  return ENGINEER_REQUIRED_LIVE_READ_SURFACES.map((surface) => ({
    surfaceId: surface.id,
    fact: {
      transport: 'api' as const,
      endpoint: `GET /e12-binder-path/${surface.id}`,
      mapperVersion: MAPPER_VERSION,
      collectedAt: '2026-09-10T00:00:00.000Z',
      collector: 'e12-binder-path-not-a-device-collect',
    },
    caseId: ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_CASE_ID,
    projectId: ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_PROJECT_ID,
    observationId: `obs-${surface.id}`,
    environmentKind: 'live' as const,
    originalPresent: true,
    payload: {
      kind: 'e12-binder-path',
      surfaceId: surface.id,
      deviceCollect: false,
    },
  }));
}

export function engineerFieldAcceptanceTestDoubleAuthorizedRead() {
  const bound = bindEngineerAuthorizedDeviceReadEvidence({
    caseRevision: ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_CASE_REVISION,
    guideRevision: ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_GUIDE_REVISION,
    observations: engineerFieldAcceptanceTestDoubleBoundObservations(),
  });
  if (!bound.ok) {
    throw new Error(`test-double binder path refused: ${bound.reason}`);
  }
  return bound;
}

export async function signEngineerFieldAcceptanceTestDoubleGrant(
  now = new Date('2026-09-10T00:00:00.000Z'),
) {
  return withEngineerFieldAcceptanceTestSecret(() => signEngineerPmLiveReadGrant({
    approvedBy: 'pm-test-double',
    caseId: ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_CASE_ID,
    caseRevision: ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_CASE_REVISION,
    guideRevision: ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_GUIDE_REVISION,
    boundObservations: engineerFieldAcceptanceTestDoubleBoundObservations(),
    nonce: ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_NONCE,
    expiresAt: '2026-09-10T01:00:00.000Z',
    now,
  }));
}

export async function evaluateEngineerFieldAcceptanceTestDouble(
  now = new Date('2026-09-10T00:00:00.000Z'),
): Promise<EngineerFieldAcceptanceDecision> {
  const authorized = engineerFieldAcceptanceTestDoubleAuthorizedRead();
  const pmGrant = await signEngineerFieldAcceptanceTestDoubleGrant(now);
  return withEngineerFieldAcceptanceTestSecret(() => evaluateEngineerFieldAcceptanceGrant({
    environmentKind: 'live',
    synthetic: false,
    originalPresent: true,
    caseId: ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_CASE_ID,
    caseRevision: authorized.liveRead.caseRevision,
    guideRevision: authorized.liveRead.guideRevision,
    liveRead: authorized.liveRead,
    boundObservations: engineerFieldAcceptanceTestDoubleBoundObservations(),
    pmGrant,
    now,
  }));
}
