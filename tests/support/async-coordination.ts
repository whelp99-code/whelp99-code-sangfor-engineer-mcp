const COORDINATION_DEADLINE_MS = 2_000;

export type CoordinationSignal = {
  readonly promise: Promise<void>;
  readonly release: () => void;
};

export class CoordinationDeadlineError extends Error {
  override readonly name = 'CoordinationDeadlineError';
  constructor(readonly event: string) { super(`COORDINATION_DEADLINE_EXCEEDED: ${event}`); }
}

export function coordinationSignal(): CoordinationSignal {
  let releasePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => { releasePromise = resolve; });
  return {
    promise,
    release: () => {
      if (!releasePromise) throw new TypeError('COORDINATION_SIGNAL_NOT_INITIALIZED');
      releasePromise();
    },
  };
}

export function beforeCoordinationDeadline<T>(event: string, promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => { reject(new CoordinationDeadlineError(event)); },
      COORDINATION_DEADLINE_MS,
    );
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}
