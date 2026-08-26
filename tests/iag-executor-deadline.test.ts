import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  BrowserExecutionContext,
  BrowserExecutionPort,
  BrowserExecutionRequest,
  BrowserExecutionResult,
} from '../packages/sangfor-browser-contracts/src/index.js';
import type { IagMutationActionAuthority } from '../packages/sangfor-competency/src/index.js';
import { createIagExecutor } from '../packages/sangfor-product-adapters/src/apply/index.js';
import {
  cleanupTestIagMutationAuthorityEnvironment,
  resolveTestIagMutationAuthority,
} from './helpers/iag-mutation-contract-fixture.js';
import {
  deferred,
  executorActionFor,
  executorObservation,
  executorResult,
  FakeDispatchScheduler,
  IAG_EXECUTOR_TEST_NOW,
} from './helpers/iag-executor-runtime-fixture.js';

let root = '';
let authority: IagMutationActionAuthority;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'iag-executor-deadline-'));
  authority = await resolveTestIagMutationAuthority(root);
});
afterAll(() => {
  cleanupTestIagMutationAuthorityEnvironment();
  rmSync(root, { recursive: true, force: true });
});

describe('IAG bounded dispatch', () => {
  it.each(['ignored', 'respected'] as const)(
    'Given never-settling dispatch with abort %s, When deadline fires, Then read-back proceeds once and dispatch work is detached safely',
    async (abortBehavior) => {
      const action = executorActionFor('qa.example.invalid', authority);
      const scheduler = new FakeDispatchScheduler();
      let context: BrowserExecutionContext | undefined;
      let active = false;
      const dispatch = deferred<BrowserExecutionResult>();
      const entered = deferred<void>();
      const executionPort: BrowserExecutionPort = {
        async execute(request, executionContext) {
          if (request.operation.kind === 'observe_console') {
            return executorResult(request, executorObservation(action));
          }
          context = executionContext;
          active = true;
          entered.resolve();
          if (abortBehavior === 'respected') {
            executionContext?.signal.addEventListener('abort', () => {
              active = false;
              dispatch.reject(new Error('dispatch aborted'));
            }, { once: true });
          }
          return dispatch.promise;
        },
      };
      const readBack = vi.fn<BrowserExecutionPort['execute']>(async (request) => (
        executorResult(request, executorObservation(action))
      ));
      const executor = createIagExecutor({
        executionPort, readBackPort: { execute: readBack }, now: () => IAG_EXECUTOR_TEST_NOW,
        dispatchTimeoutMs: 1_000, scheduler,
      });

      const pending = executor.execute(action);
      await entered.promise;
      expect(scheduler.armed).toBe(true);
      expect(context?.deadline).toBe('2026-08-20T11:01:01.000Z');
      scheduler.expire();
      const output = await pending;

      expect(context?.signal.aborted).toBe(true);
      expect(output.dispatch).toMatchObject({ status: 'UNKNOWN', error: { code: 'DISPATCH_DEADLINE_EXCEEDED' } });
      expect(output.mutationAttempted).toBe(true);
      expect(output.readBack?.proof.result).toBe('MISMATCHED');
      expect(readBack).toHaveBeenCalledOnce();
      expect(scheduler.armed).toBe(false);
      if (abortBehavior === 'ignored') {
        active = false;
        dispatch.reject(new Error('late ignored failure'));
      }
      await dispatch.promise.then(() => undefined, () => undefined);
      expect(active).toBe(false);
    },
  );

  it.each(['success', 'failure'] as const)(
    'Given dispatch deadline already returned, When a late %s settles, Then output and binding remain unchanged',
    async (lateOutcome) => {
      const action = executorActionFor('qa.example.invalid', authority);
      const scheduler = new FakeDispatchScheduler();
      const dispatch = deferred<BrowserExecutionResult>();
      const entered = deferred<void>();
      let dispatchedRequest: BrowserExecutionRequest | undefined;
      const executionPort: BrowserExecutionPort = {
        async execute(request) {
          if (request.operation.kind === 'observe_console') {
            return executorResult(request, executorObservation(action));
          }
          dispatchedRequest = request;
          entered.resolve();
          return dispatch.promise;
        },
      };
      const readBack = vi.fn<BrowserExecutionPort['execute']>(async (request) => (
        executorResult(request, executorObservation(action))
      ));
      const executor = createIagExecutor({
        executionPort, readBackPort: { execute: readBack }, now: () => IAG_EXECUTOR_TEST_NOW,
        dispatchTimeoutMs: 1_000, scheduler,
      });

      const pending = executor.execute(action);
      await entered.promise;
      scheduler.expire();
      const output = await pending;
      const request = dispatchedRequest;
      if (request === undefined) throw new TypeError('DISPATCH_REQUEST_MISSING');
      if (lateOutcome === 'success') dispatch.resolve(executorResult(request));
      else dispatch.reject(new Error('late dispatch failure'));
      await dispatch.promise.then(() => undefined, () => undefined);
      const replay = await executor.execute(action);

      expect(output.dispatch?.status).toBe('UNKNOWN');
      expect(replay.dispatch?.status).toBe('ALREADY_DISPATCHED');
      expect(readBack).toHaveBeenCalledOnce();
      expect(scheduler.cancelCalls).toBe(1);
    },
  );
});
