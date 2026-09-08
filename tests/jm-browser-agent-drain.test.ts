import { createServer } from 'node:net';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkServerIdentity } from '../packages/sangfor-jm-agent/src/index.js';
import { composeJmAgent, JmAgentStartupError } from '../apps/jm-browser-agent/src/composition.js';
import { createJmAgentServer } from '../apps/jm-browser-agent/src/server.js';
import {
  JmStartupPreflightError, buildCoordinator, exitCodeFor, installSignalHandlers,
  startJmAgentProcess,
} from '../apps/jm-browser-agent/src/process.js';
import {
  operatedReadinessPreflight, operatedStartupPreflight, probeLoopbackBind,
} from '../apps/jm-browser-agent/src/operated-execution.js';
import { browserRequest, createFakeExecutionPort } from './helpers/jm-agent-fixture.js';
import { ExactSignal } from './helpers/exact-signal.js';
import {
  call, chromiumStubPath, environment, fixtureRoot, freshJournalRoot, profileRootPath,
  signedDispatch, signingMaterial, tlsMaterial, withServer,
} from './helpers/jm-agent-tls-integration-fixture.js';

describe('drain lifecycle', () => {
  it('returns ONE shared promise and is idempotent across double signals', async () => {
    const fake = createFakeExecutionPort();
    const composition = composeJmAgent(environment(), { executionPort: fake });
    const server = createJmAgentServer(composition);
    await server.listen();
    const coordinator = buildCoordinator(composition, server);

    const first = coordinator.drain();
    const second = coordinator.drain();

    expect(first).toBe(second);
    await expect(first).resolves.toMatchObject({ kind: 'drained' });
    // Draining again after completion still yields the same settled promise.
    expect(coordinator.drain()).toBe(first);
    expect(fake.closes()).toBe(1);
    expect(composition.runtime.liveness()).toMatchObject({ state: 'closed' });
  });

  it('marks unready immediately and closes on the exact in-flight completion', async () => {
    const composition = composeJmAgent(environment(), { executionPort: createFakeExecutionPort() });
    const server = createJmAgentServer(composition);
    const port = await server.listen();
    const coordinator = buildCoordinator(composition, server);
    const entered = new ExactSignal('in-flight job entered');
    const release = server.inFlight.enter();
    entered.resolve();
    await entered.promise;

    const drained = coordinator.drain();

    const during = await call(port, '/ready');
    expect(during.status).toBe(503);
    expect(JSON.parse(during.body)).toMatchObject({
      checks: { drain: { ok: false, reason: 'DRAINING' } },
    });

    release();
    await expect(drained).resolves.toMatchObject({ kind: 'drained' });
    expect(composition.runtime.liveness()).toMatchObject({ ok: false, state: 'closed' });
  });

  it('aborts active executors on the deadline and still closes cleanly', async () => {
    let releaseHold: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { releaseHold = resolve; });
    const fake = createFakeExecutionPort({ hold: () => held });
    const composition = composeJmAgent(environment({
      SANGFOR_JM_AGENT_DRAIN_DEADLINE_MS: '50',
    }), { executionPort: fake });
    const server = createJmAgentServer(composition);
    const coordinator = buildCoordinator(composition, server);

    // Given one executor genuinely running through the production seam.
    const release = server.inFlight.enter();
    const controller = new AbortController();
    const stop = composition.active.register(controller);
    const running = composition.executionPort.execute(browserRequest(), {
      signal: controller.signal, deadline: new Date().toISOString(),
    });
    // The executor observes its abort and finishes; the drain then settles.
    controller.signal.addEventListener('abort', () => {
      releaseHold();
      void running.then(() => { stop(); release(); });
    }, { once: true });

    const outcome = await coordinator.drain();

    expect(outcome.kind).toBe('aborted_then_drained');
    expect(composition.runtime.liveness()).toMatchObject({ state: 'closed' });
  });

  it('reports typed FAILURE and never "closed" when an executor ignores its abort', async () => {
    const composition = composeJmAgent(environment({
      SANGFOR_JM_AGENT_DRAIN_DEADLINE_MS: '50',
    }), { executionPort: createFakeExecutionPort({ ignoreAbort: true }) });
    const server = createJmAgentServer(composition);
    const coordinator = buildCoordinator(composition, server);

    // Given work that never completes no matter how often it is aborted.
    server.inFlight.enter();

    const outcome = await coordinator.drain();

    expect(outcome).toMatchObject({ kind: 'failed', outstanding: 1 });
    expect(composition.runtime.state()).toBe('failed');
    expect(composition.runtime.liveness()).toMatchObject({ ok: false, state: 'failed' });
  });

  it('drains idempotently when the server never started listening', async () => {
    const composition = composeJmAgent(environment(), { executionPort: createFakeExecutionPort() });
    const server = createJmAgentServer(composition);
    const coordinator = buildCoordinator(composition, server);

    await expect(coordinator.drain()).resolves.toMatchObject({ kind: 'drained' });
    await expect(coordinator.drain()).resolves.toMatchObject({ kind: 'drained' });
  });
});
