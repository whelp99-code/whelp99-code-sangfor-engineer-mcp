import type { RemoteJobReservation } from '@sangfor/browser-contracts';
import type { BlroDispatchCandidate } from './blro-remote-dispatcher.js';
import type { RemoteJobCompletionObserver } from './remote-job-completion.js';
import type { PendingRemoteJob } from './remote-job-classification.js';

type RemoteJobClassification = RemoteJobReservation | BlroDispatchCandidate | PendingRemoteJob;

type PendingRemoteJobResolution = {
  readonly pending: PendingRemoteJob;
  readonly observer: RemoteJobCompletionObserver;
  readonly timeoutMs: number;
  readonly classify: () => Promise<RemoteJobClassification>;
  readonly waiting: ((requestId: string) => Promise<void>) | undefined;
};

export async function resolvePendingRemoteJob(
  input: PendingRemoteJobResolution,
): Promise<RemoteJobReservation | BlroDispatchCandidate> {
  let completed: RemoteJobReservation | BlroDispatchCandidate | undefined;
  await input.observer.wait(
    input.pending.completionKey,
    AbortSignal.timeout(input.timeoutMs),
    async () => {
      await input.waiting?.(input.pending.requestId);
      const postSubscription = await input.classify();
      switch (postSubscription.kind) {
        case 'pending': return { kind: 'wait' };
        case 'candidate':
        case 'dispatch':
        case 'retained':
        case 'indeterminate':
        case 'refused':
        case 'unavailable':
          completed = postSubscription;
          return { kind: 'complete' };
        default: return assertNever(postSubscription);
      }
    },
  );
  const terminal = completed ?? await input.classify();
  switch (terminal.kind) {
    case 'pending': return { kind: 'indeterminate', requestId: terminal.requestId };
    case 'candidate':
    case 'dispatch':
    case 'retained':
    case 'indeterminate':
    case 'refused':
    case 'unavailable':
      return terminal;
    default: return assertNever(terminal);
  }
}

function assertNever(value: never): never {
  throw new TypeError(JSON.stringify(value));
}
