/**
 * Scoped execution of a KB browser session.
 *
 * Both the operation and the cleanup can fail, so both outcomes are captured as
 * values rather than left to `finally` — a `finally` that awaits `close()`
 * replaces an in-flight operation error with the close error and loses the
 * failure the caller actually needs to see.
 *
 * The precedence rule, applied in `resolveSessionOutcome`:
 *   - the operation failed  -> its error wins, rethrown as-is; the close error
 *     is deliberately subordinate, because it is a consequence of the session
 *     already being broken
 *   - the operation succeeded -> a close failure is the only failure there is,
 *     so it propagates instead of being hidden behind a successful result
 */
import { launchKbBrowser } from './kb-browser-launcher.js';
import type { KbBrowserHandle, KbBrowserLauncher, KbBrowserTokens } from './kb-browser-contracts.js';

type Settled<T> =
  | { readonly kind: 'fulfilled'; readonly value: T }
  | { readonly kind: 'rejected'; readonly error: unknown };

/** Runs `attempt` to completion and reports how it ended; the error is carried, never dropped. */
async function settle<T>(attempt: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { kind: 'fulfilled', value: await attempt() };
  } catch (error) {
    return { kind: 'rejected', error };
  }
}

function resolveSessionOutcome<T>(operation: Settled<T>, cleanup: Settled<void>): T {
  switch (operation.kind) {
    case 'rejected':
      throw operation.error;
    case 'fulfilled':
      switch (cleanup.kind) {
        case 'rejected':
          throw cleanup.error;
        case 'fulfilled':
          return operation.value;
        default:
          return assertNever(cleanup);
      }
    default:
      return assertNever(operation);
  }
}

function assertNever(value: never): never {
  throw new TypeError(JSON.stringify(value));
}

export async function withKbBrowser<T>(
  tokens: KbBrowserTokens,
  operation: (handle: KbBrowserHandle) => Promise<T>,
  launcher: KbBrowserLauncher = launchKbBrowser
): Promise<T> {
  const handle = await launcher(tokens);
  const result = await settle(() => operation(handle));
  const cleanup = await settle(() => handle.close());
  return resolveSessionOutcome(result, cleanup);
}
