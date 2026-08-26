import type {
  BrowserExecutionPort,
  BrowserExecutionRequest,
  BrowserExecutionResult,
} from '@sangfor/browser-contracts';
import { digestIagMutationAction, isGroundedIagMutationAction } from './iag-action-authority.js';
import {
  invokeBoundedIagDispatch,
  systemIagDispatchScheduler,
  type IagDispatchOutcome,
  type IagDispatchScheduler,
  type IagDuplicateDispatchOutcome,
} from './iag-dispatch.js';
import { canonicalIagValuesEqual } from './iag-mutation-canonical.js';
import type { GroundedIagMutationAction, IagMutationObservedState } from './iag-mutation-action.js';
import { resolveIagPolicyObservation, type IagObservationResolution } from './iag-observation.js';
import { independentlyReadBackIag, type IagIndependentReadBack } from './iag-read-back.js';

export type IagPreflight = {
  readonly status: 'READY_TO_DISPATCH' | 'NO_CHANGE_CANDIDATE' | 'AMBIGUOUS' | 'MISSING' | 'UNREADY' | 'REFUSED' | 'SKIPPED_IDEMPOTENCY';
  readonly request: BrowserExecutionRequest;
  readonly raw?: BrowserExecutionResult;
  readonly before?: IagMutationObservedState;
  readonly reasonCode?: string;
};

export type IagExecutionAdapterResult = {
  readonly actionDigest: string;
  readonly preflight: IagPreflight;
  readonly mutationAttempted: boolean;
  readonly dispatch?: IagDispatchOutcome;
  readonly readBack?: IagIndependentReadBack;
  readonly restoreCandidate?: IagMutationObservedState;
};

export interface IagExecutor {
  execute(action: GroundedIagMutationAction): Promise<IagExecutionAdapterResult>;
}

function preflightRequest(action: GroundedIagMutationAction): BrowserExecutionRequest {
  return {
    schemaVersion: 'browser-execution-request.v1',
    requestId: `${action.bindings.idempotencyKey}-preflight`,
    sessionId: action.target.sessionId,
    origin: action.target.origin,
    operation: { kind: 'observe_console', includeSnapshot: true },
  };
}

function dispatchRequest(action: GroundedIagMutationAction): BrowserExecutionRequest {
  const field = action.intent.kind === 'URL_DOMAIN_EXCEPTION'
    ? { type: 'text' as const, label: 'URL Domain Exception', value: action.intent.value }
    : { type: 'text' as const, label: 'Application Exception', value: action.intent.applicationId };
  return {
    schemaVersion: 'browser-execution-request.v1',
    requestId: `${action.bindings.idempotencyKey}-dispatch`,
    sessionId: action.target.sessionId,
    origin: action.target.origin,
    operation: {
      kind: 'perform_console_action',
      menuPath: [{ menu: 'Policy', submenu: 'Access Control' }],
      formFields: [field],
      action: { type: 'click', target: 'Add Exception', dryRun: false },
    },
  };
}

function preflightFromResolution(input: {
  readonly request: BrowserExecutionRequest;
  readonly raw: BrowserExecutionResult;
  readonly action: GroundedIagMutationAction;
  readonly resolution: IagObservationResolution;
}): IagPreflight {
  switch (input.resolution.status) {
    case 'ABSENT':
      return canonicalIagValuesEqual(input.resolution.observed, input.action.preState.observed)
        ? { status: 'READY_TO_DISPATCH', request: input.request, raw: input.raw, before: input.resolution.observed }
        : { status: 'REFUSED', request: input.request, raw: input.raw, before: input.resolution.observed, reasonCode: 'PRESTATE_DRIFT' };
    case 'EXACT':
      return canonicalIagValuesEqual(input.resolution.observed, input.action.preState.observed)
        ? { status: 'NO_CHANGE_CANDIDATE', request: input.request, raw: input.raw, before: input.resolution.observed }
        : { status: 'REFUSED', request: input.request, raw: input.raw, before: input.resolution.observed, reasonCode: 'PRESTATE_DRIFT' };
    case 'AMBIGUOUS':
    case 'MISSING':
    case 'UNREADY':
    case 'REFUSED':
      return { status: input.resolution.status, request: input.request, raw: input.raw, reasonCode: input.resolution.reasonCode };
    default:
      input.resolution satisfies never;
      return { status: 'UNREADY', request: input.request, raw: input.raw, reasonCode: 'PREFLIGHT_UNKNOWN' };
  }
}

async function preflight(input: {
  readonly action: GroundedIagMutationAction;
  readonly port: BrowserExecutionPort;
}): Promise<IagPreflight> {
  const request = preflightRequest(input.action);
  try {
    const raw = await input.port.execute(request);
    return preflightFromResolution({
      request, raw, action: input.action,
      resolution: resolveIagPolicyObservation({ action: input.action, result: raw, requestId: request.requestId }),
    });
  } catch (error) {
    return {
      status: 'UNREADY', request, reasonCode: error instanceof Error ? 'PREFLIGHT_ERROR' : 'PREFLIGHT_UNKNOWN_ERROR',
    };
  }
}

const DEFAULT_DISPATCH_TIMEOUT_MS = 30_000;

function duplicateDispatch(input: {
  readonly idempotencyKey: string;
  readonly firstActionDigest: string;
  readonly actionDigest: string;
}): IagDuplicateDispatchOutcome {
  return input.firstActionDigest === input.actionDigest
    ? {
      status: 'ALREADY_DISPATCHED', code: 'already_dispatched',
      idempotencyKey: input.idempotencyKey, firstActionDigest: input.firstActionDigest,
    }
    : {
      status: 'IDEMPOTENCY_CONFLICT', code: 'idempotency_conflict',
      idempotencyKey: input.idempotencyKey, firstActionDigest: input.firstActionDigest,
      conflictingActionDigest: input.actionDigest,
    };
}

export function createIagExecutor(options: {
  readonly executionPort: BrowserExecutionPort;
  readonly readBackPort: BrowserExecutionPort;
  readonly now: () => Date;
  readonly dispatchTimeoutMs?: number;
  readonly scheduler?: IagDispatchScheduler;
}): IagExecutor {
  if (options.executionPort === options.readBackPort) {
    throw new TypeError('IAG_INDEPENDENT_READ_BACK_PORT_REQUIRED');
  }
  const dispatchTimeoutMs = options.dispatchTimeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS;
  if (!Number.isSafeInteger(dispatchTimeoutMs) || dispatchTimeoutMs <= 0) {
    throw new TypeError('IAG_DISPATCH_TIMEOUT_INVALID');
  }
  const scheduler = options.scheduler ?? systemIagDispatchScheduler;
  const actionDigestByIdempotencyKey = new Map<string, string>();
  return {
    async execute(action) {
      if (!isGroundedIagMutationAction(action)) throw new TypeError('IAG_ACTION_AUTHORITY_REQUIRED');
      const actionDigest = digestIagMutationAction(action);
      const idempotencyKey = action.bindings.idempotencyKey;
      const existingDigest = actionDigestByIdempotencyKey.get(idempotencyKey);
      if (existingDigest !== undefined) {
        const dispatch = duplicateDispatch({
          idempotencyKey, firstActionDigest: existingDigest, actionDigest,
        });
        return {
          actionDigest,
          preflight: {
            status: 'SKIPPED_IDEMPOTENCY', request: preflightRequest(action),
            reasonCode: dispatch.code,
          },
          mutationAttempted: false,
          dispatch,
        };
      }
      const observed = await preflight({ action, port: options.executionPort });
      if (observed.status === 'NO_CHANGE_CANDIDATE') {
        return {
          actionDigest, preflight: observed, mutationAttempted: false,
          readBack: await independentlyReadBackIag({ action, port: options.readBackPort, now: options.now }),
        };
      }
      if (observed.status !== 'READY_TO_DISPATCH') {
        return { actionDigest, preflight: observed, mutationAttempted: false };
      }

      const firstActionDigest = actionDigestByIdempotencyKey.get(idempotencyKey);
      if (firstActionDigest !== undefined) {
        const dispatch = duplicateDispatch({ idempotencyKey, firstActionDigest, actionDigest });
        return { actionDigest, preflight: observed, mutationAttempted: false, dispatch };
      }

      actionDigestByIdempotencyKey.set(idempotencyKey, actionDigest);
      const request = dispatchRequest(action);
      const dispatch = await invokeBoundedIagDispatch({
        request, port: options.executionPort, now: options.now,
        timeoutMs: dispatchTimeoutMs, scheduler,
      });
      return {
        actionDigest,
        preflight: observed,
        mutationAttempted: true,
        dispatch,
        readBack: await independentlyReadBackIag({ action, port: options.readBackPort, now: options.now }),
        restoreCandidate: observed.before,
      };
    },
  };
}
