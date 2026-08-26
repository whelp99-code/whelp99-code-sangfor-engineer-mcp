import type {
  BrowserExecutionPort,
  BrowserExecutionRequest,
  BrowserExecutionResult,
} from '@sangfor/browser-contracts';

export interface IagDispatchSchedule {
  readonly cancel: () => void;
}

export interface IagDispatchScheduler {
  arm(delayMs: number, callback: () => void): IagDispatchSchedule;
}

export type IagDispatchOutcome =
  | {
    readonly status: 'SETTLED';
    readonly request: BrowserExecutionRequest;
    readonly receipt: BrowserExecutionResult;
    readonly error?: never;
  }
  | {
    readonly status: 'UNKNOWN';
    readonly request: BrowserExecutionRequest;
    readonly receipt?: never;
    readonly error: {
      readonly code: 'DISPATCH_ERROR' | 'DISPATCH_DEADLINE_EXCEEDED';
      readonly message: string;
    };
  }
  | {
    readonly status: 'ALREADY_DISPATCHED';
    readonly code: 'already_dispatched';
    readonly idempotencyKey: string;
    readonly firstActionDigest: string;
    readonly request?: never;
    readonly receipt?: never;
    readonly error?: never;
  }
  | {
    readonly status: 'IDEMPOTENCY_CONFLICT';
    readonly code: 'idempotency_conflict';
    readonly idempotencyKey: string;
    readonly firstActionDigest: string;
    readonly conflictingActionDigest: string;
    readonly request?: never;
    readonly receipt?: never;
    readonly error?: never;
  };

export type IagDuplicateDispatchOutcome = Extract<
  IagDispatchOutcome,
  { readonly status: 'ALREADY_DISPATCHED' | 'IDEMPOTENCY_CONFLICT' }
>;

export const systemIagDispatchScheduler: IagDispatchScheduler = {
  arm(delayMs, callback) {
    const timer = setTimeout(callback, delayMs);
    return { cancel: () => clearTimeout(timer) };
  },
};

function dispatchError(
  request: BrowserExecutionRequest,
  error: unknown,
  deadlineExpired: boolean,
): IagDispatchOutcome {
  return {
    status: 'UNKNOWN',
    request,
    error: deadlineExpired
      ? {
        code: 'DISPATCH_DEADLINE_EXCEEDED',
        message: 'Dispatch did not settle before its deadline; mutation state is unknown.',
      }
      : {
        code: 'DISPATCH_ERROR',
        message: error instanceof Error ? error.message : 'Unknown dispatch error',
      },
  };
}

export async function invokeBoundedIagDispatch(input: {
  readonly request: BrowserExecutionRequest;
  readonly port: BrowserExecutionPort;
  readonly now: () => Date;
  readonly timeoutMs: number;
  readonly scheduler: IagDispatchScheduler;
}): Promise<IagDispatchOutcome> {
  const controller = new AbortController();
  const deadline = new Date(input.now().getTime() + input.timeoutMs).toISOString();
  let deadlineExpired = false;
  let schedule: IagDispatchSchedule | undefined;
  const expired = new Promise<IagDispatchOutcome>((resolve) => {
    schedule = input.scheduler.arm(input.timeoutMs, () => {
      deadlineExpired = true;
      resolve(dispatchError(input.request, undefined, true));
      controller.abort(new DOMException('Dispatch deadline exceeded.', 'TimeoutError'));
    });
  });

  const invocation = Promise.resolve().then(() => (
    input.port.execute(input.request, { signal: controller.signal, deadline })
  ));
  const settled = invocation.then<IagDispatchOutcome, IagDispatchOutcome>(
    (receipt) => ({ status: 'SETTLED', request: input.request, receipt }),
    (error: unknown) => dispatchError(input.request, error, deadlineExpired),
  );
  const outcome = await Promise.race([settled, expired]);
  schedule?.cancel();
  return outcome;
}
