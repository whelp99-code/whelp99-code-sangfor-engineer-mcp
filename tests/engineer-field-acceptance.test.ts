import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  evaluateEngineerFieldAcceptanceGrant,
  signEngineerPmLiveReadGrant,
} from '../packages/sangfor-approval/src/engineer-field-acceptance-grant.js';
import {
  ENGINEER_FIELD_ACCEPTANCE_GRANT_KIND,
  ENGINEER_REQUIRED_LIVE_READ_SURFACES,
  evaluateEngineerFieldAcceptance,
} from '../packages/shared/src/engineer-field-acceptance.js';
import {
  ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_CASE_ID,
  ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_CASE_REVISION,
  ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_GUIDE_REVISION,
  ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_SECRET,
  engineerFieldAcceptanceTestDoubleLiveRead,
  evaluateEngineerFieldAcceptanceTestDouble,
} from './support/engineer-field-acceptance-test-double.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = new Date('2026-09-10T00:00:00.000Z');

describe('engineer field acceptance gate (E12)', () => {
  it('never grants field_accepted from fixture, review_ready, Word, or workflow PASS', () => {
    const fixture = evaluateEngineerFieldAcceptance({
      environmentKind: 'fixture',
      synthetic: true,
      originalPresent: false,
      guideReadiness: 'review_ready',
      wordExportOk: true,
      workflowCompletedNormally: true,
      developerTestPass: true,
    });
    expect(fixture.fieldAccepted).toBe(false);
    expect(fixture.grantPath).toBe('none');
    expect(fixture.liveRead).toBe('not_run');
    expect(fixture.mutationDispatchCount).toBe(0);
    expect(fixture.refusedReasons).toEqual(expect.arrayContaining([
      'FIXTURE_IS_NOT_FIELD_ACCEPTED',
      'REVIEW_READY_IS_NOT_FIELD_ACCEPTED',
      'WORD_DOWNLOAD_IS_NOT_FIELD_ACCEPTED',
      'WORKFLOW_PASS_IS_NOT_FIELD_ACCEPTED',
      'DEVELOPER_TEST_IS_NOT_FIELD_ACCEPTED',
      'PM_LIVE_READ_REVIEW_REQUIRED',
      'LIVE_READ_NOT_RUN',
    ]));
    expect(fixture.requiredLiveSurfaces).toHaveLength(ENGINEER_REQUIRED_LIVE_READ_SURFACES.length);
    expect(fixture.requiredLiveSurfaces.every((item) => item.status === 'NOT_RUN')).toBe(true);
  });

  it('refuses claimed grants, historical records, and execution flags', () => {
    const claimed = evaluateEngineerFieldAcceptance({
      environmentKind: 'live',
      originalPresent: true,
      claimedFieldAccepted: true,
      liveProof: true,
      grantKind: ENGINEER_FIELD_ACCEPTANCE_GRANT_KIND,
      pmAttestation: {
        actorId: 'pm-1',
        decision: 'accept_after_live_read',
        liveCollectStatus: 'ran',
      },
      allowRealExecution: true,
    });
    expect(claimed.fieldAccepted).toBe(false);
    expect(claimed.liveRead).toBe('not_run');
    expect(claimed.refusedReasons).toEqual(expect.arrayContaining([
      'CLAIMED_FIELD_ACCEPTED_IS_NOT_A_GRANT',
      'CLAIMED_LIVE_PROOF_IS_NOT_A_LIVE_READ',
      'EXECUTION_FLAG_IS_NOT_FIELD_ACCEPTANCE',
      'ATTESTATION_STRING_IS_NOT_A_GRANT',
      'ATTESTED_LIVE_COLLECT_WITHOUT_IN_PROCESS_READ',
      'LIVE_READ_NOT_RUN',
    ]));

    const historical = evaluateEngineerFieldAcceptance({
      environmentKind: 'historical_record',
      originalPresent: true,
    });
    expect(historical.fieldAccepted).toBe(false);
    expect(historical.refusedReasons).toContain('HISTORICAL_RECORD_IS_NOT_CURRENT_LIVE');
    expect(historical.refusedReasons).toContain('LIVE_READ_NOT_RUN');

    const unknownGrant = evaluateEngineerFieldAcceptance({
      grantKind: 'fixture_reviewer',
    });
    expect(unknownGrant.fieldAccepted).toBe(false);
    expect(unknownGrant.refusedReasons).toContain('UNKNOWN_FIELD_ACCEPTANCE_GRANT_KIND');
  });

  it('kitchen-sink forge still refuses on the grant recorder', () => {
    const forged = evaluateEngineerFieldAcceptanceGrant({
      environmentKind: 'live',
      originalPresent: true,
      synthetic: false,
      guideReadiness: 'review_ready',
      wordExportOk: true,
      workflowCompletedNormally: true,
      developerTestPass: true,
      liveProof: true,
      claimedFieldAccepted: true,
      grantKind: ENGINEER_FIELD_ACCEPTANCE_GRANT_KIND,
      pmAttestation: {
        actorId: 'pm-forge',
        decision: 'accept_after_live_read',
        liveCollectStatus: 'ran',
      },
      allowRealExecution: true,
      caseRevision: 'rev-forged',
      guideRevision: 'rev-forged',
      liveRead: {
        executed: true,
        environmentKind: 'live',
        originalPresent: true,
        synthetic: false,
        sourceKind: 'authorized_device_read',
        caseRevision: 'rev-forged',
        guideRevision: 'rev-forged',
      },
      pmGrant: {
        approvedBy: 'pm-forge',
        decision: 'accept_after_live_read',
        caseId: 'forged-case',
        caseRevision: 'rev-forged',
        guideRevision: 'rev-forged',
        nonce: 'forged-nonce',
        expiresAt: '2026-09-10T01:00:00.000Z',
        approvalToken: 'c'.repeat(64),
      },
      secret: ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_SECRET,
      now: NOW,
    });
    expect(forged.fieldAccepted).toBe(false);
    expect(forged.grantPath).toBe('none');
    expect(forged.refusedReasons).toEqual(expect.arrayContaining([
      'CLAIMED_FIELD_ACCEPTED_IS_NOT_A_GRANT',
      'CLAIMED_LIVE_PROOF_IS_NOT_A_LIVE_READ',
      'EXECUTION_FLAG_IS_NOT_FIELD_ACCEPTANCE',
      'PM_GRANT_SIGNATURE_MISMATCH',
    ]));
  });

  it('refuses fixture plus an attestation string', () => {
    const attested = evaluateEngineerFieldAcceptanceGrant({
      environmentKind: 'fixture',
      synthetic: true,
      originalPresent: true,
      grantKind: ENGINEER_FIELD_ACCEPTANCE_GRANT_KIND,
      pmAttestation: {
        actorId: 'pm-1',
        decision: 'accept_after_live_read',
        liveCollectStatus: 'ran',
      },
    });
    expect(attested.fieldAccepted).toBe(false);
    expect(attested.liveRead).toBe('not_run');
    expect(attested.refusedReasons).toEqual(expect.arrayContaining([
      'FIXTURE_IS_NOT_FIELD_ACCEPTED',
      'ATTESTATION_STRING_IS_NOT_A_GRANT',
      'LIVE_READ_NOT_RUN',
    ]));
  });

  it('refuses a synthetic live-shaped fixture even with a matching HMAC', () => {
    const liveRead = engineerFieldAcceptanceTestDoubleLiveRead({
      environmentKind: 'fixture',
      synthetic: true,
      sourceKind: 'fixture',
    });
    const pmGrant = signEngineerPmLiveReadGrant({
      secret: ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_SECRET,
      approvedBy: 'pm-test-double',
      caseId: ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_CASE_ID,
      caseRevision: liveRead.caseRevision,
      guideRevision: liveRead.guideRevision,
      liveRead,
      now: NOW,
    });
    const shaped = evaluateEngineerFieldAcceptanceGrant({
      environmentKind: 'live',
      synthetic: true,
      originalPresent: true,
      caseId: ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_CASE_ID,
      caseRevision: liveRead.caseRevision,
      guideRevision: liveRead.guideRevision,
      liveRead,
      pmGrant,
      secret: ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_SECRET,
      now: NOW,
    });
    expect(shaped.fieldAccepted).toBe(false);
    expect(shaped.grantPath).toBe('none');
    expect(shaped.liveRead).toBe('refused');
    expect(shaped.refusedReasons).toEqual(expect.arrayContaining([
      'FIXTURE_IS_NOT_FIELD_ACCEPTED',
      'SYNTHETIC_LIVE_SHAPED_FIXTURE_IS_NOT_LIVE',
    ]));
  });

  it('refuses a structurally live read when the PM grant secret is missing', () => {
    const liveRead = engineerFieldAcceptanceTestDoubleLiveRead();
    const pmGrant = signEngineerPmLiveReadGrant({
      secret: ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_SECRET,
      approvedBy: 'pm-test-double',
      caseId: ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_CASE_ID,
      caseRevision: liveRead.caseRevision,
      guideRevision: liveRead.guideRevision,
      liveRead,
      now: NOW,
    });
    const missing = evaluateEngineerFieldAcceptanceGrant({
      environmentKind: 'live',
      synthetic: false,
      originalPresent: true,
      caseId: ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_CASE_ID,
      caseRevision: liveRead.caseRevision,
      guideRevision: liveRead.guideRevision,
      liveRead,
      pmGrant,
      now: NOW,
    });
    expect(missing.fieldAccepted).toBe(false);
    expect(missing.refusedReasons).toContain('FIELD_ACCEPTANCE_SECRET_MISSING');
  });

  it('refuses when the live read and the case under review differ in revision', () => {
    const liveRead = engineerFieldAcceptanceTestDoubleLiveRead();
    const pmGrant = signEngineerPmLiveReadGrant({
      secret: ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_SECRET,
      approvedBy: 'pm-test-double',
      caseId: ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_CASE_ID,
      caseRevision: liveRead.caseRevision,
      guideRevision: liveRead.guideRevision,
      liveRead,
      now: NOW,
    });
    const conflict = evaluateEngineerFieldAcceptanceGrant({
      environmentKind: 'live',
      synthetic: false,
      originalPresent: true,
      caseId: ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_CASE_ID,
      caseRevision: 'rev-other-case',
      guideRevision: liveRead.guideRevision,
      liveRead,
      pmGrant,
      secret: ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_SECRET,
      now: NOW,
    });
    expect(conflict.fieldAccepted).toBe(false);
    expect(conflict.refusedReasons).toContain('REVISION_CONFLICT');
  });

  it('grants only from the explicit HMAC test double with live originalPresent evidence', () => {
    const granted = evaluateEngineerFieldAcceptanceTestDouble(NOW);
    expect(granted.fieldAccepted).toBe(true);
    expect(granted.grantPath).toBe(ENGINEER_FIELD_ACCEPTANCE_GRANT_KIND);
    expect(granted.liveRead).toBe('executed');
    expect(granted.refusedReasons).toEqual([]);
    expect(granted.mutationDispatchCount).toBe(0);
    expect(granted.reasonCode).toBe('PM_LIVE_READ_REVIEW_GRANTED');

    const sharedStillRefuses = evaluateEngineerFieldAcceptance({
      environmentKind: 'live',
      synthetic: false,
      originalPresent: true,
      grantKind: ENGINEER_FIELD_ACCEPTANCE_GRANT_KIND,
      liveRead: engineerFieldAcceptanceTestDoubleLiveRead(),
      pmGrant: signEngineerPmLiveReadGrant({
        secret: ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_SECRET,
        approvedBy: 'pm-test-double',
        caseId: ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_CASE_ID,
        caseRevision: ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_CASE_REVISION,
        guideRevision: ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_GUIDE_REVISION,
        liveRead: engineerFieldAcceptanceTestDoubleLiveRead(),
        now: NOW,
      }),
    });
    expect(sharedStillRefuses.fieldAccepted).toBe(false);
    expect(sharedStillRefuses.grantPath).toBe('none');
    expect(sharedStillRefuses.liveRead).toBe('not_run');
  });

  it('keeps the field-session checklist secret-free and names the required live surfaces', () => {
    const checklist = readFileSync(
      resolve(ROOT, 'docs/references/engineer-workflow/e12-field-session-checklist.md'),
      'utf8',
    );
    expect(checklist).toMatch(/NOT_RUN/);
    expect(checklist).not.toMatch(/password\s*[:=]\s*\S+/i);
    expect(checklist).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
    expect(checklist).not.toMatch(/can grant `field_accepted` only through an explicit human\/PM `pm_live_read_review`/);
    expect(checklist).toMatch(/live originalPresent/);
    expect(checklist).toMatch(/structured PM grant/);
    expect(checklist).toMatch(/matching revision/);
    for (const surface of ENGINEER_REQUIRED_LIVE_READ_SURFACES) {
      expect(checklist).toContain(surface.id);
    }
  });
});
