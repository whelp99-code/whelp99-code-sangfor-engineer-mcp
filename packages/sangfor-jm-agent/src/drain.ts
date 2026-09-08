import { InFlightJobs, DrainTimeoutError } from './in-flight.js';

export type DrainOutcome =
  | { readonly kind: 'drained' }
  | { readonly kind: 'aborted_then_drained'; readonly aborted: number }
  | { readonly kind: 'failed'; readonly outstanding: number };

export type DrainDependencies = {
  readonly inFlight: InFlightJobs;
  readonly deadlineMs: number;
  readonly beginDrain: () => void;
  readonly abortActive: () => number;
  readonly closeServer: () => Promise<void>;
  readonly closeResources: () => Promise<void>;
  readonly markClosed: () => void;
  readonly markFailed: () => void;
};

/**
 * Drains exactly once.
 *
 * The first call owns the work; every later call — a second signal, a manual
 * stop, a shutdown racing a signal — receives the SAME promise, so the sequence
 * can never run twice. On the deadline the active executor controllers are
 * aborted and the in-flight set is awaited again; only when everything has
 * settled is the agent marked closed. If an executor ignores its abort, the
 * result is a typed failure and the state is 'failed' — never 'closed' with
 * work still outstanding.
 */
export class DrainCoordinator {
  private pending: Promise<DrainOutcome> | undefined;

  constructor(private readonly dependencies: DrainDependencies) {}

  drain(): Promise<DrainOutcome> {
    this.pending ??= this.run();
    return this.pending;
  }

  private async run(): Promise<DrainOutcome> {
    const dependencies = this.dependencies;
    dependencies.beginDrain();
    const outcome = await this.awaitSettled();
    // The server stops accepting before resources close, so a late connection
    // cannot find a half-released browser.
    await dependencies.closeServer();
    await dependencies.closeResources();
    if (outcome.kind === 'failed') {
      dependencies.markFailed();
      return outcome;
    }
    dependencies.markClosed();
    return outcome;
  }

  private async awaitSettled(): Promise<DrainOutcome> {
    const dependencies = this.dependencies;
    try {
      await dependencies.inFlight.awaitIdle(AbortSignal.timeout(dependencies.deadlineMs));
      return { kind: 'drained' };
    } catch (error) {
      if (!(error instanceof DrainTimeoutError)) throw error;
    }
    const aborted = dependencies.abortActive();
    try {
      await dependencies.inFlight.awaitIdle(AbortSignal.timeout(dependencies.deadlineMs));
      return { kind: 'aborted_then_drained', aborted };
    } catch (error) {
      if (!(error instanceof DrainTimeoutError)) throw error;
      return { kind: 'failed', outstanding: dependencies.inFlight.outstanding };
    }
  }
}

/** Tracks live executor controllers so a drain deadline can abort them. */
export class ActiveExecutions {
  private readonly controllers = new Set<AbortController>();

  register(controller: AbortController): () => void {
    this.controllers.add(controller);
    return () => this.controllers.delete(controller);
  }

  abortAll(): number {
    const count = this.controllers.size;
    for (const controller of this.controllers) {
      controller.abort(new Error('JM_DRAIN_DEADLINE'));
    }
    return count;
  }
}
