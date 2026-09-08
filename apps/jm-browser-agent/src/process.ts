import {
  DrainCoordinator,
  type DrainOutcome,
  type JmAgentEnvironment,
} from '../../../packages/sangfor-jm-agent/src/index.js';
import { composeJmAgent, type ComposeOptions, type JmAgentComposition } from './composition.js';
import { createJmAgentServer, type JmAgentServer } from './server.js';

export type JmAgentProcess = {
  readonly composition: JmAgentComposition;
  readonly server: JmAgentServer;
  readonly port: number;
  /** Always the SAME promise: draining twice can never run the sequence twice. */
  drain(): Promise<DrainOutcome>;
};

export type JmProcessOptions = ComposeOptions & {
  readonly createServer?: (composition: JmAgentComposition) => JmAgentServer;
};

/**
 * Starts only after configuration, TLS server + CA identity, key ring, grant
 * snapshot structure and an operator-established journal have been proven.
 */
export class JmStartupPreflightError extends Error {
  override readonly name = 'JmStartupPreflightError';
  constructor(readonly reason: string) {
    super(`Refusing to start: execution preflight failed (${reason})`);
  }
}

export async function startJmAgentProcess(
  environment: JmAgentEnvironment,
  options: JmProcessOptions = {},
): Promise<JmAgentProcess> {
  const composition = composeJmAgent(environment, options);
  let server: JmAgentServer | undefined;
  try {
    // The startup preflight runs EXACTLY ONCE and BEFORE any listener exists, so
    // a failed bind probe means the service never starts listening at all.
    const preflight = await composition.executionPort.startupPreflight({
      host: composition.config.bindHost,
      port: composition.config.port,
    });
    if (!preflight.ok) throw new JmStartupPreflightError(preflight.reason);
    server = (options.createServer ?? createJmAgentServer)(composition);
    const port = await server.listen();
    const coordinator = buildCoordinator(composition, server);
    return { composition, server, port, drain: () => coordinator.drain() };
  } catch (primaryError) {
    const cleanup = [composition.executionPort.close()];
    if (server !== undefined) cleanup.push(server.close());
    await Promise.allSettled(cleanup);
    throw primaryError;
  }
}

export function buildCoordinator(
  composition: JmAgentComposition,
  server: JmAgentServer,
): DrainCoordinator {
  return new DrainCoordinator({
    inFlight: server.inFlight,
    deadlineMs: composition.config.drainDeadlineMs,
    beginDrain: () => composition.runtime.beginDrain(),
    abortActive: () => composition.active.abortAll(),
    closeServer: () => server.close(),
    closeResources: () => composition.executionPort.close(),
    markClosed: () => composition.runtime.markClosed(),
    markFailed: () => composition.runtime.markFailed(),
  });
}

export type SignalHandle = {
  /** Resolves when the single memoized drain has settled. */
  readonly settled: Promise<DrainOutcome>;
  readonly signalsObserved: () => number;
  readonly dispose: () => void;
};

/**
 * Installs PERSISTENT SIGTERM and SIGINT handlers.
 *
 * They stay installed until the one memoized drain promise settles, so a
 * repeated or mixed signal mid-drain only observes that same promise. Using
 * `once` here would restore Node's default terminate-immediately behaviour on
 * the second signal and kill the process with work still in flight.
 */
export function installSignalHandlers(
  agent: JmAgentProcess,
  onSettled?: (outcome: DrainOutcome) => void,
): SignalHandle {
  let observed = 0;
  let settle: (outcome: DrainOutcome) => void = () => undefined;
  const settled = new Promise<DrainOutcome>((resolve) => { settle = resolve; });
  const handler = (): void => {
    observed += 1;
    // Every signal awaits the SAME promise; drain() is memoized. The handlers
    // are deliberately NOT removed when the drain settles: a later signal must
    // still be absorbed here rather than hitting Node's default terminate,
    // which would kill the process with exit 130 after a clean drain.
    void agent.drain().then((outcome) => {
      settle(outcome);
      onSettled?.(outcome);
    });
  };
  const dispose = (): void => {
    process.removeListener('SIGTERM', handler);
    process.removeListener('SIGINT', handler);
  };
  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);
  return { settled, signalsObserved: () => observed, dispose };
}

/** Graceful drain exits 0; a failed drain (work outstanding) exits nonzero. */
export function exitCodeFor(outcome: DrainOutcome): number {
  return outcome.kind === 'failed' ? 1 : 0;
}
