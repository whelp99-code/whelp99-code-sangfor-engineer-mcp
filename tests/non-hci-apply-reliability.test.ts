import { createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createIagOrchestrator } from '../packages/sangfor-product-adapters/src/apply/index.js';
import { cleanupTestIagMutationAuthorityEnvironment } from './helpers/iag-mutation-contract-fixture.js';
import {
  configureIagOrchestratorTestEnvironment,
  IAG_ORCHESTRATOR_NOW,
  iagOrchestratorFixture,
} from './helpers/iag-orchestrator-fixture.js';

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'non-hci-reliability-'));
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

function execute(fixture: Awaited<ReturnType<typeof iagOrchestratorFixture>>) {
  return fixture.orchestrator.execute({
    actionSource: fixture.source,
    authorityRequest: fixture.authorityRequest,
    approval: fixture.approval,
  });
}

describe('non-HCI IAG apply reliability', () => {
  it('Given a silent no-op receipt, When independent state remains absent, Then it halts without success', async () => {
    const fixture = await iagOrchestratorFixture({ root, readBackPresent: false });

    const result = await execute(fixture);

    expect(result).toMatchObject({
      outcome: 'FAILED_HALT', mutationAttempted: true, retryCount: 0,
      verifiedSuccess: false, finalReadBack: 'MISMATCHED',
    });
    expect(fixture.adapterFixture.dispatches).toHaveLength(1);
    expect(fixture.adapterFixture.readBacks).toHaveLength(1);
  });

  it('Given disconnect after possible dispatch, When read-back runs, Then uncertainty wins and no retry occurs', async () => {
    const fixture = await iagOrchestratorFixture({ root, dispatchBehavior: 'throw' });

    const result = await execute(fixture);

    expect(result).toMatchObject({
      outcome: 'INDETERMINATE', mutationAttempted: true, retryCount: 0,
      verifiedSuccess: false, reasonCode: 'DISPATCH_OUTCOME_UNKNOWN',
    });
    expect(fixture.adapterFixture.dispatches).toHaveLength(1);
    expect(fixture.adapterFixture.readBacks).toHaveLength(1);
  });

  it('Given concurrent exact requests, When both execute, Then one dispatch and one durable terminal result exist', async () => {
    const fixture = await iagOrchestratorFixture({ root });
    const request = {
      actionSource: fixture.source,
      authorityRequest: fixture.authorityRequest,
      approval: fixture.approval,
    };

    const [left, right] = await Promise.all([
      fixture.orchestrator.execute(request), fixture.orchestrator.execute(request),
    ]);

    expect(right).toEqual(left);
    expect(fixture.adapterFixture.dispatches).toHaveLength(1);
    const events = fixture.store.read(left.runId).events;
    expect(events.filter(({ state }) => ['SUCCEEDED', 'FAILED_HALT', 'INDETERMINATE'].includes(state))).toHaveLength(1);
  });

  it('Given a corrupt nonce store, When authorization reaches nonce use, Then it refuses before dispatch', async () => {
    const fixture = await iagOrchestratorFixture({ root });
    writeFileSync(join(root, 'nonces.json'), '{corrupt');

    const result = await execute(fixture);

    expect(result).toMatchObject({ outcome: 'REFUSED', mutationAttempted: false, reasonCode: 'NONCE_REFUSED' });
    expect(fixture.store.read(result.runId).events.map(({ state }) => state).slice(-3)).toEqual([
      'AUTHORIZED', 'DISPATCHING', 'REFUSED',
    ]);
    expect(fixture.adapterFixture.dispatches).toHaveLength(0);
  });

  it('Given terminal event durability without checkpoint durability, When first call and replay resolve, Then both stay sticky INDETERMINATE', async () => {
    const fixture = await iagOrchestratorFixture({
      root,
      faults: { afterEventDurable: (state) => { if (state === 'SUCCEEDED') throw new TypeError('terminal checkpoint lost'); } },
    });

    const first = await execute(fixture);
    const restarted = fixture.restart();
    const replay = await restarted.orchestrator.execute({
      actionSource: fixture.source, authorityRequest: fixture.authorityRequest, approval: fixture.approval,
    });
    const conflict = await restarted.orchestrator.execute({
      actionSource: fixture.source.replace('"dryRun":false', '"dryRun":true'),
      authorityRequest: fixture.authorityRequest, approval: fixture.approval,
    });

    expect(first).toMatchObject({ outcome: 'INDETERMINATE', reasonCode: 'PERSISTENCE_ACK_UNCERTAIN' });
    expect(replay).toEqual(first);
    expect(conflict).toMatchObject({ outcome: 'REFUSED', reasonCode: 'IDEMPOTENCY_CONFLICT' });
    expect(fixture.adapterFixture.dispatches).toHaveLength(1);
    expect(fixture.adapterFixture.readBacks).toHaveLength(1);
  });

  it('Given terminal checkpoint durability before acknowledgement loss, When first call and replay resolve, Then both return the same truthful terminal', async () => {
    const fixture = await iagOrchestratorFixture({
      root,
      faults: { afterCheckpointDurable: (state) => { if (state === 'SUCCEEDED') throw new TypeError('terminal acknowledgement lost'); } },
    });

    const first = await execute(fixture);
    const restarted = fixture.restart();
    const replay = await restarted.orchestrator.execute({
      actionSource: fixture.source, authorityRequest: fixture.authorityRequest, approval: fixture.approval,
    });

    expect(first).toMatchObject({ outcome: 'SUCCEEDED', verifiedSuccess: true });
    expect(replay).toEqual(first);
    expect(fixture.adapterFixture.dispatches).toHaveLength(1);
    expect(fixture.adapterFixture.readBacks).toHaveLength(1);
  });

  it('Given terminal append leaves an unreadable checkpoint head, When first call and replay resolve, Then both stay INDETERMINATE', async () => {
    const ledgerPath = join(root, 'orchestrator.jsonl');
    const fixture = await iagOrchestratorFixture({
      root,
      faults: { afterEventDurable: (state) => {
        if (state === 'SUCCEEDED') {
          writeFileSync(`${ledgerPath}.head.json`, '{partial-head');
          throw new TypeError('checkpoint write uncertain');
        }
      } },
    });

    const first = await execute(fixture);
    const replay = await execute(fixture);

    expect(first).toMatchObject({ outcome: 'INDETERMINATE', verifiedSuccess: false });
    expect(replay).toEqual(first);
    expect(fixture.adapterFixture.dispatches).toHaveLength(1);
  });

  it('Given sticky seal persistence fails, When exact replay restarts, Then an uncheckpointed success tail remains INDETERMINATE', async () => {
    const fault = {
      afterEventDurable: (state: string) => { if (state === 'SUCCEEDED') throw new TypeError('terminal checkpoint lost'); },
      beforeSealDurable: () => { throw new TypeError('seal unavailable'); },
    };
    const fixture = await iagOrchestratorFixture({ root, faults: fault });

    const first = await execute(fixture);
    const restarted = fixture.restart({ beforeSealDurable: fault.beforeSealDurable });
    const replay = await restarted.orchestrator.execute({
      actionSource: fixture.source, authorityRequest: fixture.authorityRequest, approval: fixture.approval,
    });

    expect(first).toMatchObject({ outcome: 'INDETERMINATE', verifiedSuccess: false });
    expect(replay).toEqual(first);
    expect(fixture.adapterFixture.dispatches).toHaveLength(1);
    expect(fixture.adapterFixture.readBacks).toHaveLength(1);
  });

  it('Given dispatch tombstone and a corrupt uncheckpointed tail with no seal, When replay restarts, Then it stays INDETERMINATE', async () => {
    const fixture = await iagOrchestratorFixture({
      root,
      faults: {
        afterEventDurable: (state) => { if (state === 'SUCCEEDED') throw new TypeError('terminal checkpoint lost'); },
        beforeSealDurable: () => { throw new TypeError('seal unavailable'); },
      },
    });
    const first = await execute(fixture);
    appendFileSync(fixture.ledgerPath, '{corrupt-tail\n');
    const restarted = fixture.restart({ beforeSealDurable: () => { throw new TypeError('seal unavailable'); } });

    const replay = await restarted.orchestrator.execute({
      actionSource: fixture.source, authorityRequest: fixture.authorityRequest, approval: fixture.approval,
    });

    expect(first.outcome).toBe('INDETERMINATE');
    expect(replay.outcome).toBe('INDETERMINATE');
    expect(fixture.adapterFixture.dispatches).toHaveLength(1);
  });

  it('Given a sticky seal and later checkpoint-head corruption, When replay restarts, Then the seal prevents success promotion', async () => {
    const fixture = await iagOrchestratorFixture({
      root,
      faults: { afterEventDurable: (state) => { if (state === 'SUCCEEDED') throw new TypeError('terminal checkpoint lost'); } },
    });
    const first = await execute(fixture);
    writeFileSync(`${fixture.ledgerPath}.head.json`, '{corrupt-head');

    const restarted = fixture.restart();
    const replay = await restarted.orchestrator.execute({
      actionSource: fixture.source, authorityRequest: fixture.authorityRequest, approval: fixture.approval,
    });

    expect(replay).toEqual(first);
    expect(replay.outcome).toBe('INDETERMINATE');
  });

  it('Given uncheckpointed NO_CHANGE_REQUIRED, When exact replay runs, Then no-op success is never promoted', async () => {
    const fixture = await iagOrchestratorFixture({
      root, observed: 'EXACT_MATCH',
      faults: { afterEventDurable: (state) => { if (state === 'NO_CHANGE_REQUIRED') throw new TypeError('terminal checkpoint lost'); } },
    });

    const first = await execute(fixture);
    const replay = await execute(fixture);

    expect(first).toMatchObject({ outcome: 'INDETERMINATE', mutationAttempted: false, verifiedSuccess: false });
    expect(replay).toEqual(first);
    expect(fixture.adapterFixture.dispatches).toHaveLength(0);
    expect(fixture.adapterFixture.readBacks).toHaveLength(1);
  });

  it('Given uncheckpointed no-change and seal failure, When replay runs, Then zero mutation remains sticky and truthful', async () => {
    const fixture = await iagOrchestratorFixture({
      root, observed: 'EXACT_MATCH',
      faults: {
        afterEventDurable: (state) => { if (state === 'NO_CHANGE_REQUIRED') throw new TypeError('terminal checkpoint lost'); },
        beforeSealDurable: () => { throw new TypeError('seal unavailable'); },
      },
    });

    const first = await execute(fixture);
    const replay = await execute(fixture);

    expect(first).toMatchObject({ outcome: 'INDETERMINATE', mutationAttempted: false });
    expect(replay).toEqual(first);
    expect(fixture.adapterFixture.dispatches).toHaveLength(0);
  });

  it('Given persistence acknowledgement loss after possible dispatch, When read-back completes, Then no success is returned', async () => {
    const fixture = await iagOrchestratorFixture({
      root,
      faults: { afterEventDurable: (state) => { if (state === 'VERIFYING') throw new TypeError('lost acknowledgement'); } },
    });

    const result = await execute(fixture);

    expect(result).toMatchObject({
      outcome: 'INDETERMINATE', mutationAttempted: true,
      verifiedSuccess: false, reasonCode: 'PERSISTENCE_ACK_UNCERTAIN',
    });
    expect(fixture.adapterFixture.dispatches).toHaveLength(1);
    expect(fixture.adapterFixture.readBacks).toHaveLength(1);
  });

  it('Given an interrupted durable run, When a restarted orchestrator reconciles, Then it cannot dispatch or invent success', async () => {
    const fixture = await iagOrchestratorFixture({ root });
    const runId = createHash('sha256').update(`iag-orchestrator-run\0${fixture.action.bindings.idempotencyKey}`).digest('hex');
    expect(fixture.store.claim(runId, fixture.actionDigest).kind).toBe('FRESH');
    fixture.store.append({ runId, requestDigest: fixture.actionDigest, state: 'VALIDATING' });
    const restarted = createIagOrchestrator({
      executor: fixture.adapterFixture.executor, store: fixture.store, now: () => IAG_ORCHESTRATOR_NOW,
    });

    const result = restarted.reconcile(runId);

    expect(result).toMatchObject({
      outcome: 'INDETERMINATE', mutationAttempted: false,
      verifiedSuccess: false, reasonCode: 'RESTART_AFTER_INCOMPLETE_RUN',
    });
    expect(fixture.adapterFixture.dispatches).toHaveLength(0);
    expect(restarted.reconcile(runId)).toEqual(result);
  });

  it('Given a corrupted hash chain, When execution claims a run, Then the store fails closed', async () => {
    const fixture = await iagOrchestratorFixture({ root });
    writeFileSync(fixture.ledgerPath, '{"forged":true}\n');

    await expect(execute(fixture)).rejects.toThrow('IAG_ORCHESTRATOR_STORE_UNAVAILABLE');
    expect(fixture.adapterFixture.dispatches).toHaveLength(0);
  });
});
