import {
  createBrowserExecutionAuthorityPort,
  type BrowserExecutionPort,
  type BrowserExecutionRequest,
  type BrowserExecutionResult,
} from '../../packages/sangfor-browser-contracts/src/index.js';
import type { IagMutationActionAuthority } from '../../packages/sangfor-competency/src/index.js';
import {
  createIagExecutor,
  type GroundedIagMutationAction,
  type IagDispatchScheduler,
  type IagPolicyObservation,
} from '../../packages/sangfor-product-adapters/src/apply/index.js';
import { groundAction, urlActionInput } from './iag-mutation-contract-fixture.js';

export const IAG_EXECUTOR_TEST_NOW = new Date('2026-08-20T11:01:00.000Z');

export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  const callbacks: {
    resolve?: Deferred<T>['resolve'];
    reject?: Deferred<T>['reject'];
  } = {};
  const promise = new Promise<T>((resolve, reject) => {
    callbacks.resolve = resolve;
    callbacks.reject = reject;
  });
  return {
    promise,
    resolve(value) {
      const callback = callbacks.resolve;
      if (callback === undefined) throw new TypeError('DEFERRED_RESOLVE_UNAVAILABLE');
      callback(value);
    },
    reject(reason) {
      const callback = callbacks.reject;
      if (callback === undefined) throw new TypeError('DEFERRED_REJECT_UNAVAILABLE');
      callback(reason);
    },
  };
}

export class FakeDispatchScheduler implements IagDispatchScheduler {
  private deadlineCallback: (() => void) | undefined;
  armCalls = 0;
  cancelCalls = 0;

  arm(_delayMs: number, callback: () => void): { readonly cancel: () => void } {
    this.armCalls += 1;
    this.deadlineCallback = callback;
    return {
      cancel: () => {
        this.cancelCalls += 1;
        this.deadlineCallback = undefined;
      },
    };
  }

  expire(): void {
    const callback = this.deadlineCallback;
    if (callback === undefined) throw new TypeError('FAKE_DEADLINE_NOT_ARMED');
    this.deadlineCallback = undefined;
    callback();
  }

  get armed(): boolean {
    return this.deadlineCallback !== undefined;
  }
}

export function executorActionFor(
  value: 'qa.example.invalid' | 'example.com',
  authority: IagMutationActionAuthority,
): GroundedIagMutationAction {
  const input = urlActionInput('ABSENT', authority);
  return groundAction({
    ...input,
    preState: { mode: 'absent_or_exact_match', observed: { kind: 'URL_DOMAIN_EXCEPTION_ABSENT', value } },
    intent: { kind: 'URL_DOMAIN_EXCEPTION', value, effect: 'ALLOW' },
    readBackExpectation: {
      ...input.readBackExpectation,
      expected: { kind: 'URL_DOMAIN_EXCEPTION_PRESENT', value, effect: 'ALLOW' },
    },
  }, authority);
}

export function executorObservation(
  action: GroundedIagMutationAction,
  present = false,
): IagPolicyObservation {
  return {
    schemaVersion: 'iag-policy-observation.v1', origin: action.target.origin,
    originDigest: action.target.originDigest, deviceIdentityDigest: action.target.deviceIdentityDigest,
    firmwareTruthDigest: action.firmwareTruth.truthDigest, implementation: action.implementation,
    policy: {
      product: 'IAG', capabilityId: 'internet_policy', taskId: action.bindings.taskId,
      status: 'READY', entries: present ? [action.readBackExpectation.expected] : [],
    },
  };
}

export function executorResult(
  request: BrowserExecutionRequest,
  observed?: IagPolicyObservation,
): BrowserExecutionResult {
  return {
    schemaVersion: 'browser-execution-result.v1', requestId: request.requestId,
    status: observed === undefined ? 'INDETERMINATE' : 'PASS',
    mutationAttempted: observed === undefined,
    readBack: { status: observed === undefined ? 'INDETERMINATE' : 'PASS' },
    ...(observed === undefined ? {} : { observations: { iagPolicy: observed } }), evidence: [],
  };
}

export function replayFixture(
  actions: readonly GroundedIagMutationAction[],
  dispatchBehavior: 'settle' | 'throw' = 'settle',
  preflightPresent = false,
  readBackPresent = true,
) {
  const preflights: BrowserExecutionRequest[] = [];
  const dispatches: BrowserExecutionRequest[] = [];
  const readBacks: BrowserExecutionRequest[] = [];
  const executionPort: BrowserExecutionPort = {
    async execute(request) {
      if (request.operation.kind === 'observe_console') {
        const action = actions[preflights.length];
        preflights.push(request);
        if (action === undefined) throw new TypeError('UNEXPECTED_PREFLIGHT');
        return executorResult(request, executorObservation(action, preflightPresent));
      }
      dispatches.push(request);
      if (dispatchBehavior === 'throw') throw new Error('dispatch connection lost');
      return executorResult(request);
    },
  };
  const readBackPort: BrowserExecutionPort = {
    async execute(request) {
      readBacks.push(request);
      const action = actions[0];
      if (action === undefined) throw new TypeError('MISSING_ACTION');
      return executorResult(request, executorObservation(action, readBackPresent));
    },
  };
  return {
    executor: createIagExecutor({
      executionPort: createBrowserExecutionAuthorityPort(executionPort),
      readBackPort: createBrowserExecutionAuthorityPort(readBackPort),
      now: () => IAG_EXECUTOR_TEST_NOW,
      dispatchTimeoutMs: 1_000, scheduler: new FakeDispatchScheduler(),
    }),
    executionPort, readBackPort, preflights, dispatches, readBacks,
  };
}
