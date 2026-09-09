import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ENGINEER_FIELD_ACCEPTANCE_GRANT_KIND,
  ENGINEER_REQUIRED_LIVE_READ_SURFACES,
  evaluateEngineerFieldAcceptance,
} from '../packages/shared/src/engineer-field-acceptance.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('engineer field acceptance gate (E12 prep)', () => {
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

  it('keeps the field-session checklist secret-free and names the required live surfaces', () => {
    const checklist = readFileSync(
      resolve(ROOT, 'docs/references/engineer-workflow/e12-field-session-checklist.md'),
      'utf8',
    );
    expect(checklist).toMatch(/NOT_RUN/);
    expect(checklist).not.toMatch(/password\s*[:=]\s*\S+/i);
    expect(checklist).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
    for (const surface of ENGINEER_REQUIRED_LIVE_READ_SURFACES) {
      expect(checklist).toContain(surface.id);
    }
  });
});
