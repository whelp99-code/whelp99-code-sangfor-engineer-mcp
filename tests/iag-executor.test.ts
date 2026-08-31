import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createBrowserExecutionAuthorityPort,
  type BrowserExecutionPort,
  type BrowserExecutionRequest,
  type BrowserExecutionResult,
  type JsonValue,
} from '../packages/sangfor-browser-contracts/src/index.js';
import type { IagMutationActionAuthority } from '../packages/sangfor-competency/src/index.js';
import {
  createIagExecutor,
  type GroundedIagMutationAction,
  type IagPolicyObservation,
} from '../packages/sangfor-product-adapters/src/apply/index.js';
import {
  cleanupTestIagMutationAuthorityEnvironment,
  groundAction,
  resolveTestIagMutationAuthority,
  urlActionInput,
} from './helpers/iag-mutation-contract-fixture.js';

const NOW = new Date('2026-08-20T11:01:00.000Z');
let root = '';
let authority: IagMutationActionAuthority;

function result(request: BrowserExecutionRequest, observations?: Record<string, JsonValue>, over: Partial<BrowserExecutionResult> = {}): BrowserExecutionResult {
  return {
    schemaVersion: 'browser-execution-result.v1', requestId: request.requestId,
    status: 'PASS', mutationAttempted: false, readBack: { status: 'PASS' },
    observations, evidence: [], ...over,
  };
}

function observation(action: GroundedIagMutationAction, entries: Extract<IagPolicyObservation['policy'], { status: 'READY' }>['entries'] = [], status: 'READY' | 'MISSING' | 'UNREADY' = 'READY'): IagPolicyObservation {
  const shared = {
    product: 'IAG' as const, capabilityId: 'internet_policy' as const, taskId: action.bindings.taskId,
  };
  const policy = status === 'READY'
    ? { ...shared, status, entries }
    : status === 'MISSING'
      ? { ...shared, status, entries: [] }
      : { ...shared, status, entries: [], reasonCode: 'POLICY_LOADING' };
  return {
    schemaVersion: 'iag-policy-observation.v1', origin: action.target.origin,
    originDigest: action.target.originDigest, deviceIdentityDigest: action.target.deviceIdentityDigest,
    firmwareTruthDigest: action.firmwareTruth.truthDigest, implementation: action.implementation, policy,
  };
}

function ports(before: JsonValue, after: JsonValue, dispatch: 'change' | 'noop' | 'throw' = 'change') {
  const executionRequests: BrowserExecutionRequest[] = [];
  const readBackRequests: BrowserExecutionRequest[] = [];
  const execute = vi.fn<BrowserExecutionPort['execute']>(async (request) => {
    executionRequests.push(request);
    if (request.operation.kind === 'observe_console') return result(request, { iagPolicy: before });
    if (dispatch === 'throw') throw new Error('connection dropped');
    return result(request, dispatch === 'change' ? { misleading: 'saved' } : { misleading: 'success' }, {
      status: 'INDETERMINATE', mutationAttempted: true, readBack: { status: 'INDETERMINATE' },
    });
  });
  const verify = vi.fn<BrowserExecutionPort['execute']>(async (request) => {
    readBackRequests.push(request);
    return result(request, { iagPolicy: after });
  });
  return {
    executor: createIagExecutor({
      executionPort: createBrowserExecutionAuthorityPort({ execute }),
      readBackPort: createBrowserExecutionAuthorityPort({ execute: verify }),
      now: () => NOW,
    }),
    execute, verify, executionRequests, readBackRequests,
  };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'iag-executor-'));
  authority = await resolveTestIagMutationAuthority(root);
});
afterAll(() => {
  cleanupTestIagMutationAuthorityEnvironment();
  rmSync(root, { recursive: true, force: true });
});

describe('IAG exact exception executor', () => {
  it('Given ready absent state, When executed, Then one semantic dispatch and a separate independent read-back occur', async () => {
    const action = groundAction(urlActionInput('ABSENT', authority), authority);
    const before = observation(action);
    const after = observation(action, [action.readBackExpectation.expected]);
    const fixture = ports(before, after);

    const output = await fixture.executor.execute(action);

    expect(output.preflight.status).toBe('READY_TO_DISPATCH');
    expect(output.mutationAttempted).toBe(true);
    expect(output.readBack?.status).toBe('MATCHED');
    expect(output.restoreCandidate).toEqual(action.preState.observed);
    expect(fixture.execute).toHaveBeenCalledTimes(2);
    expect(fixture.verify).toHaveBeenCalledOnce();
    expect(fixture.executionRequests.filter(({ operation }) => operation.kind === 'perform_console_action')).toHaveLength(1);
    expect(fixture.readBackRequests[0]?.sessionId).toBe(action.readBackExpectation.verifierSessionId);
    expect(fixture.readBackRequests[0]).not.toBe(fixture.executionRequests[0]);
  });

  it('Given exact state already exists, When executed, Then no dispatch occurs and independent proof remains candidate data', async () => {
    const action = groundAction(urlActionInput('EXACT_MATCH', authority), authority);
    const exact = observation(action, [action.readBackExpectation.expected]);
    const fixture = ports(exact, exact);

    const output = await fixture.executor.execute(action);

    expect(output.preflight.status).toBe('NO_CHANGE_CANDIDATE');
    expect(output.mutationAttempted).toBe(false);
    expect(output.readBack?.status).toBe('MATCHED');
    expect(fixture.execute).toHaveBeenCalledOnce();
    expect(fixture.verify).toHaveBeenCalledOnce();
  });

  it.each([
    ['ambiguous duplicate', (action: GroundedIagMutationAction) => observation(action, [action.readBackExpectation.expected, action.readBackExpectation.expected]), 'AMBIGUOUS'],
    ['missing policy', (action: GroundedIagMutationAction) => observation(action, [], 'MISSING'), 'MISSING'],
    ['unready policy', (action: GroundedIagMutationAction) => observation(action, [], 'UNREADY'), 'UNREADY'],
  ])('Given %s preflight, When executed, Then mutation is refused', async (_case, makeBefore, expected) => {
    const action = groundAction(urlActionInput('ABSENT', authority), authority);
    const fixture = ports(makeBefore(action), observation(action));

    const output = await fixture.executor.execute(action);

    expect(output.preflight.status).toBe(expected);
    expect(output.mutationAttempted).toBe(false);
    expect(fixture.execute).toHaveBeenCalledOnce();
    expect(fixture.verify).not.toHaveBeenCalled();
  });

  it.each([
    ['origin', (candidate: IagPolicyObservation): JsonValue => ({ ...candidate, origin: 'https://other.invalid' })],
    ['device', (candidate: IagPolicyObservation): JsonValue => ({ ...candidate, deviceIdentityDigest: '9'.repeat(64) })],
    ['firmware digest', (candidate: IagPolicyObservation): JsonValue => ({ ...candidate, firmwareTruthDigest: '9'.repeat(64) })],
    ['recipe digest', (candidate: IagPolicyObservation): JsonValue => ({ ...candidate, implementation: { ...candidate.implementation, recipeDigest: '9'.repeat(64) } })],
  ])('Given wrong %s at preflight, When executed, Then scope drift refuses before dispatch', async (_case, mutate) => {
    const action = groundAction(urlActionInput('ABSENT', authority), authority);
    const fixture = ports(mutate(observation(action)), observation(action));

    const output = await fixture.executor.execute(action);

    expect(output.preflight.status).toBe('REFUSED');
    expect(output.mutationAttempted).toBe(false);
    expect(fixture.execute).toHaveBeenCalledOnce();
  });

  it('Given malformed preflight data, When executed, Then it remains unready without dispatch', async () => {
    const action = groundAction(urlActionInput('ABSENT', authority), authority);
    const fixture = ports({ misleading: 'ready' }, observation(action));

    const output = await fixture.executor.execute(action);

    expect(output.preflight).toMatchObject({ status: 'UNREADY', reasonCode: 'OBSERVATION_MALFORMED' });
    expect(output.mutationAttempted).toBe(false);
    expect(fixture.execute).toHaveBeenCalledOnce();
  });

  it('Given a click that silently changes nothing, When independently read, Then the adapter reports mismatch rather than trusting receipt', async () => {
    const action = groundAction(urlActionInput('ABSENT', authority), authority);
    const absent = observation(action);
    const fixture = ports(absent, absent, 'noop');

    const output = await fixture.executor.execute(action);

    expect(output.dispatch?.receipt?.observations).toEqual({ misleading: 'success' });
    expect(output.readBack?.status).toBe('MISMATCHED');
    expect(output.readBack?.proof.result).toBe('MISMATCHED');
  });

  it('Given ambiguous independent read-back, When executed, Then proof is indeterminate data', async () => {
    const action = groundAction(urlActionInput('ABSENT', authority), authority);
    const duplicate = observation(action, [action.readBackExpectation.expected, action.readBackExpectation.expected]);
    const fixture = ports(observation(action), duplicate);

    const output = await fixture.executor.execute(action);

    expect(output.readBack?.status).toBe('INDETERMINATE');
    expect(output.readBack?.proof.result).toBe('INDETERMINATE');
  });

  it('Given read-back error after dispatch, When executed, Then independent proof is indeterminate', async () => {
    const action = groundAction(urlActionInput('ABSENT', authority), authority);
    const fixture = ports(observation(action), observation(action));
    fixture.verify.mockRejectedValueOnce(new Error('read failed'));

    const output = await fixture.executor.execute(action);

    expect(output.mutationAttempted).toBe(true);
    expect(output.readBack?.status).toBe('INDETERMINATE');
    expect(output.readBack?.proof.result).toBe('INDETERMINATE');
  });

  it('Given disconnect after possible dispatch, When executed, Then mutation remains attempted and no retry occurs', async () => {
    const action = groundAction(urlActionInput('ABSENT', authority), authority);
    const fixture = ports(observation(action), observation(action), 'throw');

    const output = await fixture.executor.execute(action);

    expect(output.mutationAttempted).toBe(true);
    expect(output.dispatch?.error?.code).toBe('DISPATCH_ERROR');
    expect(output.readBack?.status).toBe('MISMATCHED');
    expect(fixture.executionRequests.filter(({ operation }) => operation.kind === 'perform_console_action')).toHaveLength(1);
  });

  it('Given one port object for mutation and verification, When composed, Then independence is refused', () => {
    const port: BrowserExecutionPort = { execute: vi.fn<BrowserExecutionPort['execute']>() };

    expect(() => createIagExecutor({ executionPort: port, readBackPort: port, now: () => NOW })).toThrow(
      'IAG_INDEPENDENT_READ_BACK_PORT_REQUIRED',
    );
  });

  it('Given concurrent execution of one action, When both reach dispatch, Then the executor dispatches at most once', async () => {
    const action = groundAction(urlActionInput('ABSENT', authority), authority);
    const fixture = ports(observation(action), observation(action, [action.readBackExpectation.expected]));

    const outputs = await Promise.all([fixture.executor.execute(action), fixture.executor.execute(action)]);

    expect(fixture.executionRequests.filter(({ operation }) => operation.kind === 'perform_console_action')).toHaveLength(1);
    expect(outputs.filter(({ mutationAttempted }) => mutationAttempted)).toHaveLength(1);
  });
});
