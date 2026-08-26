import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BrowserExecutionPort } from '../packages/sangfor-browser-contracts/src/index.js';
import {
  createIagExecutor,
  createIagOrchestrator,
  lookupIagRunStatus,
} from '../packages/sangfor-product-adapters/src/apply/index.js';
import { consumeIagMutationNonce } from '../packages/sangfor-operator/src/index.js';
import { cleanupTestIagMutationAuthorityEnvironment } from './helpers/iag-mutation-contract-fixture.js';
import {
  deferred,
  executorObservation,
  executorResult,
  FakeDispatchScheduler,
} from './helpers/iag-executor-runtime-fixture.js';
import {
  configureIagOrchestratorTestEnvironment,
  IAG_ORCHESTRATOR_NOW,
  iagOrchestratorFixture,
} from './helpers/iag-orchestrator-fixture.js';

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'iag-reversible-apply-'));
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

function request(fixture: Awaited<ReturnType<typeof iagOrchestratorFixture>>) {
  return {
    actionSource: fixture.source,
    authorityRequest: fixture.authorityRequest,
    approval: fixture.approval,
  };
}

function expectBounded(result: {
  readonly retryCount: number;
  readonly promotionEligible: boolean;
  readonly mutationAttempted: boolean;
}, mutationAttempted: boolean): void {
  expect(result).toMatchObject({ retryCount: 0, promotionEligible: false, mutationAttempted });
}

function expectNoRollback(fixture: Awaited<ReturnType<typeof iagOrchestratorFixture>>, runId: string): void {
  expect(fixture.store.read(runId).events.some(({ state }) => state.includes('ROLLBACK'))).toBe(false);
}

function orchestratorWithPorts(
  fixture: Awaited<ReturnType<typeof iagOrchestratorFixture>>,
  executionPort: BrowserExecutionPort,
  readBackPort: BrowserExecutionPort,
) {
  const executor = createIagExecutor({
    executionPort, readBackPort, now: () => IAG_ORCHESTRATOR_NOW,
    dispatchTimeoutMs: 1_000, scheduler: new FakeDispatchScheduler(),
  });
  return createIagOrchestrator({ executor, store: fixture.store, now: () => IAG_ORCHESTRATOR_NOW });
}

describe('Todo 17 reversible IAG apply reliability', () => {
  it('Given a silent no-op dispatch, When independent read-back stays absent, Then it maps exactly to FAILED_HALT', async () => {
    const fixture = await iagOrchestratorFixture({ root, readBackPresent: false });

    const result = await fixture.orchestrator.execute(request(fixture));

    expect(result).toMatchObject({ outcome: 'FAILED_HALT', finalReadBack: 'MISMATCHED', verifiedSuccess: false });
    expectBounded(result, true);
    expect(fixture.adapterFixture.dispatches).toHaveLength(1);
    expect(fixture.adapterFixture.readBacks).toHaveLength(1);
    expectNoRollback(fixture, result.runId);
  });

  it('Given an ambiguous target before dispatch, When preflight resolves, Then it REFUSES and consumes no approval', async () => {
    const fixture = await iagOrchestratorFixture({ root });
    const executionPort: BrowserExecutionPort = {
      async execute(browserRequest) {
        if (browserRequest.operation.kind !== 'observe_console') {
          return fixture.adapterFixture.executionPort.execute(browserRequest);
        }
        const observation = executorObservation(fixture.action, true);
        return executorResult(browserRequest, {
          ...observation,
          policy: { ...observation.policy, entries: [fixture.action.readBackExpectation.expected, fixture.action.readBackExpectation.expected] },
        });
      },
    };
    const orchestrator = orchestratorWithPorts(fixture, executionPort, fixture.adapterFixture.readBackPort);

    const result = await orchestrator.execute(request(fixture));

    expect(result).toMatchObject({ outcome: 'REFUSED', reasonCode: 'MULTIPLE_EXACT_TARGETS' });
    expectBounded(result, false);
    expect(fixture.adapterFixture.dispatches).toHaveLength(0);
    await expect(consumeIagMutationNonce(fixture.approval, IAG_ORCHESTRATOR_NOW)).resolves.toEqual({ ok: true });
  });

  it('Given independent read-back failure after dispatch, When verification resolves, Then it is INDETERMINATE once', async () => {
    const fixture = await iagOrchestratorFixture({ root });
    let readBackCalls = 0;
    const failedReadBack: BrowserExecutionPort = {
      async execute() {
        readBackCalls += 1;
        throw new TypeError('independent verifier unavailable');
      },
    };
    const orchestrator = orchestratorWithPorts(fixture, fixture.adapterFixture.executionPort, failedReadBack);

    const result = await orchestrator.execute(request(fixture));

    expect(result).toMatchObject({ outcome: 'INDETERMINATE', finalReadBack: 'INDETERMINATE', reasonCode: 'READ_BACK_INDETERMINATE' });
    expectBounded(result, true);
    expect(fixture.adapterFixture.dispatches).toHaveLength(1);
    expect(readBackCalls).toBe(1);
    expectNoRollback(fixture, result.runId);
  });

  it('Given disconnect after possible dispatch, When read-back matches, Then dispatch uncertainty remains INDETERMINATE', async () => {
    const fixture = await iagOrchestratorFixture({ root, dispatchBehavior: 'throw' });

    const result = await fixture.orchestrator.execute(request(fixture));

    expect(result).toMatchObject({ outcome: 'INDETERMINATE', reasonCode: 'DISPATCH_OUTCOME_UNKNOWN', verifiedSuccess: false });
    expectBounded(result, true);
    expect(fixture.adapterFixture.dispatches).toHaveLength(1);
    expect(fixture.adapterFixture.readBacks).toHaveLength(1);
    expectNoRollback(fixture, result.runId);
  });

  it('Given one approval and 32 ready consumers, When released together, Then exactly one mutation and read-back occur', async () => {
    const fixture = await iagOrchestratorFixture({ root });
    const start = deferred<void>();
    const consumers = Array.from({ length: 32 }, async () => {
      await start.promise;
      return fixture.orchestrator.execute(request(fixture));
    });

    start.resolve();
    const results = await Promise.all(consumers);

    expect(results.every((result) => result.outcome === 'SUCCEEDED')).toBe(true);
    expect(new Set(results.map(({ runId }) => runId)).size).toBe(1);
    expect(fixture.adapterFixture.dispatches).toHaveLength(1);
    expect(fixture.adapterFixture.readBacks).toHaveLength(1);
    const first = results[0];
    if (first === undefined) throw new TypeError('CONCURRENT_RESULT_MISSING');
    expectBounded(first, true);
    expectNoRollback(fixture, first.runId);
  });

  it('Given a consumed terminal approval, When 32 replays are released, Then every apply REFUSES and status stays stable', async () => {
    const fixture = await iagOrchestratorFixture({ root, authorityKind: 'ordinary_active' });
    const first = await fixture.orchestrator.execute({ ...request(fixture), ordinaryAuthorityRequired: true });
    const start = deferred<void>();
    const consumers = Array.from({ length: 32 }, async () => {
      await start.promise;
      return fixture.orchestrator.execute({ ...request(fixture), ordinaryAuthorityRequired: true });
    });
    const before = lookupIagRunStatus(fixture.store, first.runId);

    start.resolve();
    const replays = await Promise.all(consumers);
    const after = lookupIagRunStatus(fixture.store, first.runId);

    expect(replays.every(({ outcome, reasonCode }) => outcome === 'REFUSED' && reasonCode === 'APPROVAL_REPLAY')).toBe(true);
    expect(after).toEqual(before);
    expect(fixture.adapterFixture.dispatches).toHaveLength(1);
    expect(fixture.adapterFixture.readBacks).toHaveLength(1);
  });
});
