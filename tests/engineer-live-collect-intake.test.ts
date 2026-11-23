import { afterEach, describe, expect, it } from 'vitest';
import { startEngineerLiveCollect } from '../packages/sangfor-hci-client/src/engineer-live-collect-start.js';
import {
  ENGINEER_LIVE_COLLECT_INTAKE_FIELDS,
  evaluateEngineerLiveCollectStart,
  type EngineerLiveCollectIntake,
} from '../packages/shared/src/engineer-live-collect-intake.js';
import { runEngineerWorkflow } from './support/engineer-workflow-pipeline.js';

const AUTH = { tenantId: 'tenant-a', projectId: 'proj-a', actorId: 'actor-a' } as const;

const COMPLETE_INTAKE: EngineerLiveCollectIntake = {
  authorizedReadOnlyTarget: {
    product: 'HCI_SCP',
    firmware: 'provided-not-observed',
    reachPathClass: 'private_store_injected',
    collectionScope: 'read-only-volumes-servers-images',
  },
  e02: {
    opsConfirmation: true,
    privateStoreLocator: 'approved-private-store:hci-read-account',
  },
  janus: {
    sanitizedCaptureLocator: 'approved-private-store:janus-sanitized-capture',
  },
  retentionSanitizationScope: 'case-revision',
  caseRequirements: {
    existingCaseRequirementsConfirmed: true,
    newBuildProvidedProposedSpecsConfirmed: true,
  },
  readOnlySession: {
    confirmedReadOnly: true,
  },
};

function forbiddenFetch(): Promise<Response> {
  throw new Error('LIVE_COLLECT_MUST_NOT_CONTACT_NETWORK');
}

function forbiddenCollect(): Promise<never> {
  throw new Error('LIVE_COLLECT_MUST_NOT_COLLECT');
}

function forbiddenClient() {
  return {
    async request(): Promise<never> {
      throw new Error('LIVE_COLLECT_MUST_NOT_CONTACT_NETWORK');
    },
    async endpointFor(): Promise<never> {
      throw new Error('LIVE_COLLECT_MUST_NOT_CONTACT_NETWORK');
    },
  };
}

describe('engineer live-collect start intake (E12)', () => {
  const previousAllow = process.env.SANGFOR_ALLOW_REAL_EXECUTION;

  afterEach(() => {
    if (previousAllow === undefined) delete process.env.SANGFOR_ALLOW_REAL_EXECUTION;
    else process.env.SANGFOR_ALLOW_REAL_EXECUTION = previousAllow;
  });

  it('refuses without intake and names the six Jae-owned fields', () => {
    const refused = evaluateEngineerLiveCollectStart();
    expect(refused.ok).toBe(false);
    expect(refused.fieldAccepted).toBe(false);
    expect(refused.grantPath).toBe('none');
    expect(refused.liveRead).toBe('not_run');
    expect(refused.collectExecuted).toBe(false);
    expect(refused.networkContacted).toBe(false);
    expect(refused.reasonCode).toBe('LIVE_COLLECT_INTAKE_INCOMPLETE');
    expect(refused.mutationDispatchCount).toBe(0);
    expect(refused.missingFields.map((field) => field.id)).toEqual([
      ...ENGINEER_LIVE_COLLECT_INTAKE_FIELDS,
    ]);
    expect(refused.missingFields.every((field) => field.status === 'missing')).toBe(true);
  });

  it('does not call collect or fetch when intake is missing', async () => {
    const started = await startEngineerLiveCollect({
      collect: forbiddenCollect,
      fetch: forbiddenFetch,
    });
    expect(started.ok).toBe(false);
    expect(started.fieldAccepted).toBe(false);
    expect(started.reasonCode).toBe('LIVE_COLLECT_INTAKE_INCOMPLETE');
    expect(started.networkContacted).toBe(false);
    expect(started.collectExecuted).toBe(false);
    expect(started.missingFields).toHaveLength(ENGINEER_LIVE_COLLECT_INTAKE_FIELDS.length);
  });

  it('does not start a GET or grant field_accepted when intake is complete', async () => {
    const started = await startEngineerLiveCollect({
      intake: COMPLETE_INTAKE,
      collect: forbiddenCollect,
      fetch: forbiddenFetch,
    });
    expect(started.ok).toBe(false);
    expect(started.fieldAccepted).toBe(false);
    expect(started.reasonCode).toBe('LIVE_COLLECT_INTAKE_COMPLETE_NOT_STARTED');
    expect(started.networkContacted).toBe(false);
    expect(started.collectExecuted).toBe(false);
    expect(started.missingFields).toEqual([]);
    expect(evaluateEngineerLiveCollectStart(COMPLETE_INTAKE).ok).toBe(true);
    expect(evaluateEngineerLiveCollectStart(COMPLETE_INTAKE).fieldAccepted).toBe(false);
  });

  it('refuses real-execution and still does not contact the network', async () => {
    process.env.SANGFOR_ALLOW_REAL_EXECUTION = 'true';
    const started = await startEngineerLiveCollect({
      intake: COMPLETE_INTAKE,
      collect: forbiddenCollect,
      fetch: forbiddenFetch,
    });
    expect(started.ok).toBe(false);
    expect(started.fieldAccepted).toBe(false);
    expect(started.reasonCode).toBe('LIVE_COLLECT_REAL_EXECUTION_REFUSED');
    expect(started.missingFields.map((field) => field.id)).toContain('read_only_session_confirmation');
    expect(started.networkContacted).toBe(false);
  });

  it('rejects host-shaped or secret-shaped locators as missing intake', () => {
    const refused = evaluateEngineerLiveCollectStart({
      ...COMPLETE_INTAKE,
      e02: {
        opsConfirmation: true,
        privateStoreLocator: 'https://example.invalid/store',
      },
      janus: {
        sanitizedCaptureLocator: 'approved-private-store:password=no',
      },
    });
    expect(refused.ok).toBe(false);
    expect(refused.reasonCode).toBe('LIVE_COLLECT_INTAKE_INCOMPLETE');
    expect(refused.missingFields.map((field) => field.id)).toEqual([
      'e02_ops_confirmation_and_private_store_locator',
      'janus_sanitized_capture_or_observed_path',
    ]);
  });

  it('runEngineerWorkflow live start refuses before the inventory client is used', async () => {
    const result = await runEngineerWorkflow({
      auth: AUTH,
      caseId: 'case-live-start-intake',
      mode: 'existing',
      product: 'HCI_SCP',
      revision: 'rev-e12-live-start',
      requestId: 'e12-live-start-1',
      liveCollectStart: true,
      inventoryClient: forbiddenClient(),
      exportRoot: '/tmp/e12-live-start-unused',
    });
    expect(result.fieldAccepted).toBe(false);
    expect(result.fieldAcceptance.fieldAccepted).toBe(false);
    expect(result.liveCollectStart?.reasonCode).toBe('LIVE_COLLECT_INTAKE_INCOMPLETE');
    expect(result.liveCollectIntake.missingFields.map((field) => field.id)).toEqual([
      ...ENGINEER_LIVE_COLLECT_INTAKE_FIELDS,
    ]);
    expect(result.steps[0]).toMatchObject({
      id: 'collect',
      exportName: 'startEngineerLiveCollect',
      status: 'refused',
      reason: 'LIVE_COLLECT_INTAKE_INCOMPLETE',
    });
    expect(result.inventory).toBeUndefined();
    expect(result.liveProof).toBe(false);
  });
});
