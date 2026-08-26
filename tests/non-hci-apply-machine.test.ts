import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isIagTransitionAllowed } from '../packages/sangfor-product-adapters/src/apply/index.js';
import { cleanupTestIagMutationAuthorityEnvironment } from './helpers/iag-mutation-contract-fixture.js';
import {
  configureIagOrchestratorTestEnvironment,
  iagOrchestratorFixture,
} from './helpers/iag-orchestrator-fixture.js';

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'non-hci-machine-'));
  configureIagOrchestratorTestEnvironment(root);
});

afterEach(() => {
  cleanupTestIagMutationAuthorityEnvironment();
  for (const key of [
    'SANGFOR_ALLOW_REAL_EXECUTION', 'SANGFOR_ALLOW_PRODUCTION_EXECUTION',
    'SANGFOR_IAG_BOOTSTRAP_APPROVAL_SECRET', 'SANGFOR_OPERATOR_APPROVAL_SECRET',
    'SANGFOR_NONCE_STORE', 'SANGFOR_NONCE_STORE_PATH',
  ]) delete process.env[key];
  rmSync(root, { recursive: true, force: true });
});

async function setup(observed: 'ABSENT' | 'EXACT_MATCH' = 'ABSENT', dryRun = false) {
  return await iagOrchestratorFixture({ root, observed, dryRun });
}

describe('non-HCI IAG apply state machine', () => {
  it('Given a genuine candidate action, When approved and independently verified, Then it reaches SUCCEEDED once', async () => {
    const fixture = await setup();

    const result = await fixture.orchestrator.execute({
      actionSource: fixture.source, authorityRequest: fixture.authorityRequest, approval: fixture.approval,
    });

    expect(result).toMatchObject({ outcome: 'SUCCEEDED', mutationAttempted: true, retryCount: 0, promotionEligible: false });
    expect(fixture.adapterFixture.dispatches).toHaveLength(1);
    expect(fixture.adapterFixture.readBacks).toHaveLength(1);
    const events = fixture.store.read(result.runId).events;
    expect(events.map(({ state }) => state)).toEqual([
      'RECEIVED', 'VALIDATING', 'PREFLIGHTING', 'AUTHORIZING', 'AUTHORIZED',
      'DISPATCHING', 'VERIFYING', 'SUCCEEDED',
    ]);
    expect(events.find(({ state }) => state === 'AUTHORIZED')?.payload).toMatchObject({ approvalToken: '***' });
  });

  it('Given exact state already exists, When independently proved, Then no approval or nonce is consumed', async () => {
    const fixture = await setup('EXACT_MATCH');
    delete process.env.SANGFOR_IAG_BOOTSTRAP_APPROVAL_SECRET;

    const result = await fixture.orchestrator.execute({
      actionSource: fixture.source, authorityRequest: fixture.authorityRequest,
    });

    expect(result).toMatchObject({ outcome: 'NO_CHANGE_REQUIRED', mutationAttempted: false, verifiedSuccess: true });
    expect(fixture.adapterFixture.dispatches).toHaveLength(0);
    expect(fixture.store.read(result.runId).events.map(({ state }) => state)).toEqual([
      'RECEIVED', 'VALIDATING', 'PREFLIGHTING', 'NO_CHANGE_REQUIRED',
    ]);
  });

  it('Given dry-run intent, When preflight completes, Then it never authorizes, consumes, or dispatches', async () => {
    const fixture = await setup('ABSENT', true);
    delete process.env.SANGFOR_IAG_BOOTSTRAP_APPROVAL_SECRET;

    const result = await fixture.orchestrator.execute({
      actionSource: fixture.source, authorityRequest: fixture.authorityRequest,
    });

    expect(result).toMatchObject({ outcome: 'DRY_RUN_COMPLETE', mutationAttempted: false, verifiedSuccess: false });
    expect(fixture.adapterFixture.dispatches).toHaveLength(0);
    expect(fixture.adapterFixture.readBacks).toHaveLength(0);
  });

  it('Given active field authority, When the same request is resolved, Then the caller cannot select the ordinary branch', async () => {
    const fixture = await iagOrchestratorFixture({ root, authorityKind: 'ordinary_active' });

    const result = await fixture.orchestrator.execute({
      actionSource: fixture.source, authorityRequest: fixture.authorityRequest, approval: fixture.approval,
    });

    expect(result).toMatchObject({ outcome: 'SUCCEEDED', promotionEligible: false });
    expect(fixture.adapterFixture.dispatches).toHaveLength(1);
  });

  it('Given a public-suffix-wide exception, When validated, Then broad mutation is refused before preflight', async () => {
    const fixture = await setup();
    const authorityRequest = { ...fixture.authorityRequest, allowedUrlDomains: ['co.uk'] };

    const result = await fixture.orchestrator.execute({
      actionSource: fixture.source.replaceAll('qa.example.invalid', 'co.uk'),
      authorityRequest, approval: fixture.approval,
    });

    expect(result).toMatchObject({ outcome: 'REFUSED', reasonCode: 'SCHEMA_MISMATCH' });
    expect(fixture.adapterFixture.preflights).toHaveLength(0);
  });

  it('Given the explicit state graph, When every required edge is checked, Then no implicit transition exists', () => {
    const edges = [
      ['RECEIVED', 'VALIDATING'], ['VALIDATING', 'PREFLIGHTING'],
      ['PREFLIGHTING', 'DRY_RUN_COMPLETE'], ['PREFLIGHTING', 'NO_CHANGE_REQUIRED'],
      ['PREFLIGHTING', 'AUTHORIZING'], ['AUTHORIZING', 'REFUSED'],
      ['AUTHORIZING', 'AUTHORIZED'], ['AUTHORIZED', 'DISPATCHING'],
      ['DISPATCHING', 'VERIFYING'], ['VERIFYING', 'SUCCEEDED'],
      ['VERIFYING', 'FAILED_HALT'], ['VERIFYING', 'INDETERMINATE'],
    ] as const;
    expect(edges.every(([from, to]) => isIagTransitionAllowed(from, to))).toBe(true);
    expect(isIagTransitionAllowed('SUCCEEDED', 'DISPATCHING')).toBe(false);
  });

  it('Given a replay and a conflicting payload, When reused, Then dispatch is not duplicated', async () => {
    const fixture = await setup();
    const first = await fixture.orchestrator.execute({
      actionSource: fixture.source, authorityRequest: fixture.authorityRequest, approval: fixture.approval,
    });
    const replay = await fixture.orchestrator.execute({
      actionSource: fixture.source, authorityRequest: fixture.authorityRequest, approval: fixture.approval,
    });
    const conflict = await fixture.orchestrator.execute({
      actionSource: fixture.source.replace('"dryRun":false', '"dryRun":true'),
      authorityRequest: fixture.authorityRequest, approval: fixture.approval,
    });

    expect(replay).toEqual(first);
    expect(conflict.outcome).toBe('REFUSED');
    expect(conflict.reasonCode).toBe('IDEMPOTENCY_CONFLICT');
    expect(fixture.adapterFixture.dispatches).toHaveLength(1);
  });
});
