import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bindEngineerAuthorizedDeviceReadEvidence } from '../packages/sangfor-config-state/src/engineer-field-acceptance-bind.js';
import {
  evaluateEngineerFieldAcceptanceGrant,
  signEngineerPmLiveReadGrant,
} from '../packages/sangfor-approval/src/engineer-field-acceptance-grant.js';
import {
  ENGINEER_FIELD_ACCEPTANCE_GRANT_KIND,
  ENGINEER_FIELD_ACCEPTANCE_SECRET_ENV,
  ENGINEER_REQUIRED_LIVE_READ_SURFACES,
  evaluateEngineerFieldAcceptance,
  type EngineerFieldAcceptanceRefusal,
} from '../packages/shared/src/engineer-field-acceptance.js';
import {
  ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_CASE_ID,
  ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_SECRET,
  engineerFieldAcceptanceTestDoubleAuthorizedRead,
  engineerFieldAcceptanceTestDoubleBoundObservations,
  engineerFieldAcceptanceTestDoubleLiveRead,
  evaluateEngineerFieldAcceptanceTestDouble,
  signEngineerFieldAcceptanceTestDoubleGrant,
  withEngineerFieldAcceptanceTestSecret,
} from './support/engineer-field-acceptance-test-double.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = new Date('2026-09-10T00:00:00.000Z');

const ENV_SNAPSHOT = {
  fieldSecret: process.env[ENGINEER_FIELD_ACCEPTANCE_SECRET_ENV],
  operatorSecret: process.env.SANGFOR_OPERATOR_APPROVAL_SECRET,
  nonceStore: process.env.SANGFOR_NONCE_STORE,
  noncePath: process.env.SANGFOR_NONCE_STORE_PATH,
  authority: process.env.SANGFOR_BLRO_AUTHORITY_STORE,
};

function restoreEnv(): void {
  const assign = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  assign(ENGINEER_FIELD_ACCEPTANCE_SECRET_ENV, ENV_SNAPSHOT.fieldSecret);
  assign('SANGFOR_OPERATOR_APPROVAL_SECRET', ENV_SNAPSHOT.operatorSecret);
  assign('SANGFOR_NONCE_STORE', ENV_SNAPSHOT.nonceStore);
  assign('SANGFOR_NONCE_STORE_PATH', ENV_SNAPSHOT.noncePath);
  assign('SANGFOR_BLRO_AUTHORITY_STORE', ENV_SNAPSHOT.authority);
}

describe('engineer field acceptance gate (E12)', () => {
  let nonceDir: string;

  beforeEach(() => {
    nonceDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'e12-grant-nonce-'));
    delete process.env[ENGINEER_FIELD_ACCEPTANCE_SECRET_ENV];
    delete process.env.SANGFOR_OPERATOR_APPROVAL_SECRET;
    delete process.env.SANGFOR_NONCE_STORE;
    process.env.SANGFOR_NONCE_STORE_PATH = join(nonceDir, 'nonces.json');
    process.env.SANGFOR_BLRO_AUTHORITY_STORE = 'local';
  });

  afterEach(() => {
    restoreEnv();
    rmSync(nonceDir, { recursive: true, force: true });
  });

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
    const typed: EngineerFieldAcceptanceRefusal = fixture;
    expect(typed.fieldAccepted).toBe(false);
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

  it('kitchen-sink forge still refuses and does not report claimed liveRead as executed', async () => {
    const forged = await withEngineerFieldAcceptanceTestSecret(() => evaluateEngineerFieldAcceptanceGrant({
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
      now: NOW,
    }));
    expect(forged.fieldAccepted).toBe(false);
    expect(forged.grantPath).toBe('none');
    expect(forged.liveRead).toBe('refused');
    expect(forged.liveRead).not.toBe('executed');
    expect(forged.refusedReasons).toEqual(expect.arrayContaining([
      'CLAIMED_FIELD_ACCEPTED_IS_NOT_A_GRANT',
      'CLAIMED_LIVE_PROOF_IS_NOT_A_LIVE_READ',
      'EXECUTION_FLAG_IS_NOT_FIELD_ACCEPTANCE',
      'CLAIMED_AUTHORIZED_DEVICE_READ_WITHOUT_BOUND_FACTS',
      'OBSERVATION_DIGEST_REQUIRED',
      'REQUIRED_LIVE_SURFACES_NOT_RUN',
    ]));
    expect(forged.requiredLiveSurfaces.every((item) => item.status === 'NOT_RUN')).toBe(true);
  });

  it('refuses fixture plus an attestation string', async () => {
    const attested = await evaluateEngineerFieldAcceptanceGrant({
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

  it('refuses a synthetic live-shaped fixture even with a matching HMAC', async () => {
    const liveRead = engineerFieldAcceptanceTestDoubleLiveRead({
      environmentKind: 'fixture',
      synthetic: true,
      sourceKind: 'fixture',
    });
    const shaped = await withEngineerFieldAcceptanceTestSecret(async () => {
      const pmGrant = signEngineerPmLiveReadGrant({
        approvedBy: 'pm-test-double',
        caseId: ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_CASE_ID,
        caseRevision: liveRead.caseRevision,
        guideRevision: liveRead.guideRevision,
        boundObservations: engineerFieldAcceptanceTestDoubleBoundObservations(),
        now: NOW,
      });
      return evaluateEngineerFieldAcceptanceGrant({
        environmentKind: 'live',
        synthetic: true,
        originalPresent: true,
        caseId: ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_CASE_ID,
        caseRevision: liveRead.caseRevision,
        guideRevision: liveRead.guideRevision,
        liveRead,
        boundObservations: engineerFieldAcceptanceTestDoubleBoundObservations(),
        pmGrant,
        now: NOW,
      });
    });
    expect(shaped.fieldAccepted).toBe(false);
    expect(shaped.grantPath).toBe('none');
    expect(shaped.liveRead).not.toBe('not_run');
    expect(shaped.refusedReasons).toEqual(expect.arrayContaining([
      'FIXTURE_IS_NOT_FIELD_ACCEPTED',
      'SYNTHETIC_LIVE_SHAPED_FIXTURE_IS_NOT_LIVE',
    ]));
  });

  it('refuses a caller-built live-shaped object plus HMAC without bound facts', async () => {
    const liveRead = engineerFieldAcceptanceTestDoubleLiveRead();
    const pmGrant = await signEngineerFieldAcceptanceTestDoubleGrant(NOW);
    const claimed = await withEngineerFieldAcceptanceTestSecret(() => evaluateEngineerFieldAcceptanceGrant({
      environmentKind: 'live',
      synthetic: false,
      originalPresent: true,
      caseId: ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_CASE_ID,
      caseRevision: liveRead.caseRevision,
      guideRevision: liveRead.guideRevision,
      liveRead,
      pmGrant,
      now: NOW,
    }));
    expect(claimed.fieldAccepted).toBe(false);
    expect(claimed.liveRead).toBe('refused');
    expect(claimed.refusedReasons).toEqual(expect.arrayContaining([
      'CLAIMED_AUTHORIZED_DEVICE_READ_WITHOUT_BOUND_FACTS',
      'OBSERVATION_DIGEST_REQUIRED',
      'REQUIRED_LIVE_SURFACES_NOT_RUN',
    ]));
    expect(claimed.requiredLiveSurfaces.every((item) => item.status === 'NOT_RUN')).toBe(true);
  });

  it('ignores a caller-supplied secret argument and still fails closed without the env var', async () => {
    const authorized = engineerFieldAcceptanceTestDoubleAuthorizedRead();
    const pmGrant = await signEngineerFieldAcceptanceTestDoubleGrant(NOW);
    const missing = await evaluateEngineerFieldAcceptanceGrant({
      environmentKind: 'live',
      synthetic: false,
      originalPresent: true,
      caseId: ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_CASE_ID,
      caseRevision: authorized.liveRead.caseRevision,
      guideRevision: authorized.liveRead.guideRevision,
      liveRead: authorized.liveRead,
      boundObservations: engineerFieldAcceptanceTestDoubleBoundObservations(),
      pmGrant,
      now: NOW,
      ...({ secret: ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_SECRET } as { secret: string }),
    });
    expect(missing.fieldAccepted).toBe(false);
    expect(missing.refusedReasons).toContain('FIELD_ACCEPTANCE_SECRET_MISSING');
  });

  it('does not treat the operator write secret as the field-acceptance secret', async () => {
    process.env.SANGFOR_OPERATOR_APPROVAL_SECRET = ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_SECRET;
    const authorized = engineerFieldAcceptanceTestDoubleAuthorizedRead();
    const pmGrant = await signEngineerFieldAcceptanceTestDoubleGrant(NOW);
    const operatorOnly = await evaluateEngineerFieldAcceptanceGrant({
      environmentKind: 'live',
      synthetic: false,
      originalPresent: true,
      caseId: ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_CASE_ID,
      caseRevision: authorized.liveRead.caseRevision,
      guideRevision: authorized.liveRead.guideRevision,
      liveRead: authorized.liveRead,
      boundObservations: engineerFieldAcceptanceTestDoubleBoundObservations(),
      pmGrant,
      now: NOW,
    });
    expect(operatorOnly.fieldAccepted).toBe(false);
    expect(operatorOnly.refusedReasons).toContain('FIELD_ACCEPTANCE_SECRET_MISSING');
  });

  it('refuses when the live read and the case under review differ in revision', async () => {
    const authorized = engineerFieldAcceptanceTestDoubleAuthorizedRead();
    const pmGrant = await signEngineerFieldAcceptanceTestDoubleGrant(NOW);
    const conflict = await withEngineerFieldAcceptanceTestSecret(() => evaluateEngineerFieldAcceptanceGrant({
      environmentKind: 'live',
      synthetic: false,
      originalPresent: true,
      caseId: ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_CASE_ID,
      caseRevision: 'rev-other-case',
      guideRevision: authorized.liveRead.guideRevision,
      liveRead: authorized.liveRead,
      boundObservations: engineerFieldAcceptanceTestDoubleBoundObservations(),
      pmGrant,
      now: NOW,
    }));
    expect(conflict.fieldAccepted).toBe(false);
    expect(conflict.refusedReasons).toContain('REVISION_CONFLICT');
  });

  it('refuses a forged token even when bound facts and the env secret are present', async () => {
    const authorized = engineerFieldAcceptanceTestDoubleAuthorizedRead();
    const valid = await signEngineerFieldAcceptanceTestDoubleGrant(NOW);
    const forged = await withEngineerFieldAcceptanceTestSecret(() => evaluateEngineerFieldAcceptanceGrant({
      environmentKind: 'live',
      synthetic: false,
      originalPresent: true,
      caseId: ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_CASE_ID,
      caseRevision: authorized.liveRead.caseRevision,
      guideRevision: authorized.liveRead.guideRevision,
      liveRead: authorized.liveRead,
      boundObservations: engineerFieldAcceptanceTestDoubleBoundObservations(),
      pmGrant: { ...valid, approvalToken: 'c'.repeat(64) },
      now: NOW,
    }));
    expect(forged.fieldAccepted).toBe(false);
    expect(forged.refusedReasons).toContain('PM_GRANT_SIGNATURE_MISMATCH');
  });

  it('fixture constructors cannot mint authorized_device_read without the collect binder', () => {
    const fixtureMint = bindEngineerAuthorizedDeviceReadEvidence({
      caseRevision: 'rev-case-test-double',
      guideRevision: 'rev-guide-test-double',
      observations: engineerFieldAcceptanceTestDoubleBoundObservations().map((item) => ({
        ...item,
        environmentKind: 'fixture',
        originalPresent: false,
      })),
    });
    expect(fixtureMint.ok).toBe(false);
    if (fixtureMint.ok) throw new Error('fixture constructor must not mint authorized_device_read');
    expect(fixtureMint.reason).toBe('FIXTURE_MARKED_OBSERVED');
    expect(fixtureMint.requiredLiveSurfaces.every((item) => item.status === 'NOT_RUN')).toBe(true);
  });

  it('grants only from bound originalPresent facts plus env HMAC and a consumed nonce', async () => {
    const granted = await evaluateEngineerFieldAcceptanceTestDouble(NOW);
    expect(granted.fieldAccepted).toBe(true);
    expect(granted.grantPath).toBe(ENGINEER_FIELD_ACCEPTANCE_GRANT_KIND);
    expect(granted.liveRead).toBe('executed');
    expect(granted.refusedReasons).toEqual([]);
    expect(granted.mutationDispatchCount).toBe(0);
    expect(granted.reasonCode).toBe('PM_LIVE_READ_REVIEW_GRANTED');
    expect(granted.requiredLiveSurfaces).toHaveLength(ENGINEER_REQUIRED_LIVE_READ_SURFACES.length);
    expect(granted.requiredLiveSurfaces.every((item) => item.status === 'BOUND_ORIGINAL_PRESENT')).toBe(true);
    expect(granted.requiredLiveSurfaces.every((item) => item.status !== 'NOT_RUN')).toBe(true);

    const sharedStillRefuses = evaluateEngineerFieldAcceptance({
      environmentKind: 'live',
      synthetic: false,
      originalPresent: true,
      grantKind: ENGINEER_FIELD_ACCEPTANCE_GRANT_KIND,
      liveRead: engineerFieldAcceptanceTestDoubleLiveRead(),
      boundObservations: engineerFieldAcceptanceTestDoubleBoundObservations(),
      pmGrant: await signEngineerFieldAcceptanceTestDoubleGrant(NOW),
    });
    expect(sharedStillRefuses.fieldAccepted).toBe(false);
    expect(sharedStillRefuses.grantPath).toBe('none');
    expect(sharedStillRefuses.liveRead).toBe('not_run');
  });

  it('consumes the grant nonce so replay does not grant again', async () => {
    const first = await evaluateEngineerFieldAcceptanceTestDouble(NOW);
    expect(first.fieldAccepted).toBe(true);
    const replay = await evaluateEngineerFieldAcceptanceTestDouble(NOW);
    expect(replay.fieldAccepted).toBe(false);
    expect(replay.refusedReasons).toContain('FIELD_ACCEPTANCE_NONCE_ALREADY_USED');
  });

  it('fails closed when the nonce store is corrupt', async () => {
    writeFileSync(process.env.SANGFOR_NONCE_STORE_PATH ?? '', 'not-json');
    const corrupt = await evaluateEngineerFieldAcceptanceTestDouble(NOW);
    expect(corrupt.fieldAccepted).toBe(false);
    expect(corrupt.refusedReasons).toContain('FIELD_ACCEPTANCE_NONCE_STORE_UNAVAILABLE');
  });

  it('fails closed when a non-file nonce store is selected', async () => {
    process.env.SANGFOR_NONCE_STORE = 'postgres';
    const unavailable = await evaluateEngineerFieldAcceptanceTestDouble(NOW);
    expect(unavailable.fieldAccepted).toBe(false);
    expect(unavailable.refusedReasons).toContain('FIELD_ACCEPTANCE_NONCE_STORE_UNAVAILABLE');
  });

  it('fails closed when the local nonce authority is missing', async () => {
    delete process.env.SANGFOR_BLRO_AUTHORITY_STORE;
    const missing = await evaluateEngineerFieldAcceptanceTestDouble(NOW);
    expect(missing.fieldAccepted).toBe(false);
    expect(missing.refusedReasons).toContain('FIELD_ACCEPTANCE_NONCE_STORE_UNAVAILABLE');
  });

  it('does not consume a nonce on a refused grant', async () => {
    const liveRead = engineerFieldAcceptanceTestDoubleLiveRead();
    const pmGrant = await signEngineerFieldAcceptanceTestDoubleGrant(NOW);
    const refused = await withEngineerFieldAcceptanceTestSecret(() => evaluateEngineerFieldAcceptanceGrant({
      environmentKind: 'live',
      synthetic: false,
      originalPresent: true,
      caseId: ENGINEER_FIELD_ACCEPTANCE_TEST_DOUBLE_CASE_ID,
      caseRevision: liveRead.caseRevision,
      guideRevision: liveRead.guideRevision,
      liveRead,
      pmGrant,
      now: NOW,
    }));
    expect(refused.fieldAccepted).toBe(false);
    const later = await evaluateEngineerFieldAcceptanceTestDouble(NOW);
    expect(later.fieldAccepted).toBe(true);
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
    expect(checklist).toMatch(/consumed nonce/);
    expect(checklist).toMatch(/observation digest/);
    expect(checklist).toMatch(/SANGFOR_ENGINEER_FIELD_ACCEPTANCE_SECRET/);
    expect(checklist).toMatch(/request-supplied secret is not read/);
    for (const surface of ENGINEER_REQUIRED_LIVE_READ_SURFACES) {
      expect(checklist).toContain(surface.id);
    }
  });
});
