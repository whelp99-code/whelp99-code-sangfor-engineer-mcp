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

describe('certificate authority validity', () => {
  // See the note in the runtime suite: openssl notBefore is whole-second, so a
  // same-second wall clock can race the mint boundary.
  const now = new Date(Date.now() + 60_000);

  it('refuses an expired or not-yet-valid CA even when the leaf verifies', () => {
    for (const [caPath, reason] of [
      [tlsMaterial().expiredCaPath, 'SERVER_CA_EXPIRED'],
      [tlsMaterial().futureCaPath, 'SERVER_CA_NOT_YET_VALID'],
    ] as const) {
      const decision = checkServerIdentity({
        certPath: tlsMaterial().serverCertPath, keyPath: tlsMaterial().serverKeyPath, caPath, now,
      });

      expect(decision.ok, reason).toBe(false);
      if (decision.ok) continue;
      expect(decision.reason).toBe(reason);
    }
  });

  it('refuses a non-CA leaf presented as the trust anchor', () => {
    const decision = checkServerIdentity({
      certPath: tlsMaterial().serverCertPath, keyPath: tlsMaterial().serverKeyPath,
      caPath: tlsMaterial().clientCertPath, now,
    });

    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.reason).toBe('SERVER_CA_NOT_A_CA');
  });

  it('refuses an expired CA before any listener exists', () => {
    expect(() => composeJmAgent(environment({
      SANGFOR_JM_AGENT_TLS_CLIENT_CA_PATH: tlsMaterial().expiredCaPath,
    }), { executionPort: createFakeExecutionPort() })).toThrow(JmAgentStartupError);
  });
});

describe('persistent signal handlers', () => {
  it('observes repeated and mixed signals on ONE memoized drain promise', async () => {
    const composition = composeJmAgent(environment(), { executionPort: createFakeExecutionPort() });
    const server = createJmAgentServer(composition);
    await server.listen();
    const coordinator = buildCoordinator(composition, server);
    const agent = {
      composition, server, port: 0, drain: () => coordinator.drain(),
    };
    const barrier = new ExactSignal('drain settled');
    const handle = installSignalHandlers(agent, () => barrier.resolve());

    // Given one job held in flight so the drain cannot finish instantly.
    const release = server.inFlight.enter();
    process.emit('SIGTERM');
    process.emit('SIGINT');
    process.emit('SIGTERM');

    // Then every signal observed the SAME promise and the handlers are still
    // installed, so no signal restored default termination mid-drain.
    expect(handle.signalsObserved()).toBe(3);
    expect(process.listenerCount('SIGTERM')).toBeGreaterThan(0);

    release();
    await barrier.promise;
    await expect(handle.settled).resolves.toMatchObject({ kind: 'drained' });

    // A signal arriving AFTER the drain settled must still be absorbed by our
    // handler. If the handlers were removed on settle, Node's default would
    // terminate the process with 130 despite a clean drain.
    expect(process.listenerCount('SIGTERM')).toBeGreaterThan(0);
    expect(process.listenerCount('SIGINT')).toBeGreaterThan(0);
    process.emit('SIGINT');
    expect(handle.signalsObserved()).toBe(4);

    handle.dispose();
  });

  it('maps a graceful drain to exit 0 and a failed drain to nonzero', () => {
    expect(exitCodeFor({ kind: 'drained' })).toBe(0);
    expect(exitCodeFor({ kind: 'aborted_then_drained', aborted: 1 })).toBe(0);
    expect(exitCodeFor({ kind: 'failed', outstanding: 1 })).toBe(1);
  });
});
