import { createServer } from 'node:net';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkServerIdentity } from '../packages/sangfor-jm-agent/src/index.js';
import { REMOTE_BROWSER_JOB_PATH } from '../packages/sangfor-browser-contracts/src/index.js';
import { composeJmAgent, JmAgentStartupError } from '../apps/jm-browser-agent/src/composition.js';
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

describe('startup gate', () => {
  it('refuses incomplete TLS, signing, snapshot and operated execution configuration', () => {
    for (const field of [
      'SANGFOR_JM_AGENT_TLS_CERT_PATH',
      'SANGFOR_JM_AGENT_VERIFY_KEY_RING_PATH',
      'SANGFOR_JM_AGENT_GRANT_SNAPSHOT_PATH',
      'SANGFOR_JM_AGENT_JOURNAL_ROOT',
      'SANGFOR_JM_AGENT_BROWSER_PROFILE_REF',
      'SANGFOR_JM_AGENT_BROWSER_CHROMIUM_PATH',
      'SANGFOR_JM_AGENT_DEVICE_BINDING_DIGEST',
    ]) {
      const incomplete = environment();
      delete incomplete[field];
      expect(() => composeJmAgent(incomplete, {
        executionPort: createFakeExecutionPort(),
      }), field).toThrow(JmAgentStartupError);
    }
  });

  it('refuses a clientAuth-only or foreign server leaf before binding', () => {
    for (const patch of [
      {
        SANGFOR_JM_AGENT_TLS_CERT_PATH: tlsMaterial().clientAuthOnlyCertPath,
        SANGFOR_JM_AGENT_TLS_KEY_PATH: tlsMaterial().clientAuthOnlyKeyPath,
      },
      {
        SANGFOR_JM_AGENT_TLS_CERT_PATH: tlsMaterial().foreignServerCertPath,
        SANGFOR_JM_AGENT_TLS_KEY_PATH: tlsMaterial().foreignServerKeyPath,
      },
      {
        SANGFOR_JM_AGENT_TLS_CERT_PATH: tlsMaterial().nonLoopbackServerCertPath,
        SANGFOR_JM_AGENT_TLS_KEY_PATH: tlsMaterial().nonLoopbackServerKeyPath,
      },
    ]) {
      expect(() => composeJmAgent(environment(patch), {
        executionPort: createFakeExecutionPort(),
      }), JSON.stringify(patch)).toThrow(JmAgentStartupError);
    }
  });

  it('never includes secret bytes in the startup refusal message', () => {
    try {
      composeJmAgent(environment({ SANGFOR_JM_AGENT_TLS_KEY_PATH: tlsMaterial().otherServerKeyPath }), {
        executionPort: createFakeExecutionPort(),
      });
      expect.unreachable('mismatched key must refuse');
    } catch (error) {
      expect(String(error)).not.toContain('PRIVATE KEY');
      expect(String(error)).toContain('SERVER_CERT_KEY_MISMATCH');
    }
  });
});
describe('real operated execution preflight', () => {
  it('reports live 200 / ready 503 / job 503 with executor 0 when preflight fails', async () => {
    const failing = createFakeExecutionPort({
      preflight: () => ({ ok: false, reason: 'EXECUTION_CHROMIUM_MISSING' }),
    });

    await withServer({}, async ({ port }) => {
      const live = await call(port, '/live');
      const ready = await call(port, '/ready');
      const dispatch = signedDispatch();
      const job = await call(port, REMOTE_BROWSER_JOB_PATH, {
        body: dispatch.body, receipt: dispatch.receipt,
        receiptId: dispatch.receiptId, jobId: dispatch.jobId,
      });

      expect(live.status).toBe(200);
      expect(ready.status).toBe(503);
      expect(JSON.parse(ready.body)).toMatchObject({
        checks: { executionPreflight: { ok: false, reason: 'EXECUTION_PREFLIGHT_FAILED' } },
      });
      expect(job.status).toBe(503);
      expect(failing.calls()).toBe(0);
    }, failing);
  });

  it('refuses a missing Chromium executable and a missing profile root', () => {
    const base = {
      browserChromiumPath: chromiumStubPath(),
      browserProfileRoot: profileRootPath(),
    } satisfies Pick<Parameters<typeof operatedReadinessPreflight>[0], 'browserChromiumPath' | 'browserProfileRoot'>;

    expect(Reflect.apply(operatedReadinessPreflight, undefined, [base]).ok).toBe(true);
    expect(Reflect.apply(operatedReadinessPreflight, undefined, [{
      ...base, browserChromiumPath: '/nonexistent/chromium',
    }])).toMatchObject({ reason: 'EXECUTION_CHROMIUM_MISSING' });
    const notExecutable = join(fixtureRoot(), 'chromium-noexec');
    writeFileSync(notExecutable, 'x', { mode: 0o600 });
    expect(Reflect.apply(operatedReadinessPreflight, undefined, [{
      ...base, browserChromiumPath: notExecutable,
    }])).toMatchObject({ reason: 'EXECUTION_CHROMIUM_NOT_EXECUTABLE' });
    expect(Reflect.apply(operatedReadinessPreflight, undefined, [{
      ...base, browserProfileRoot: '/nonexistent/profile',
    }])).toMatchObject({ reason: 'EXECUTION_PROFILE_MISSING' });
  });

  it('proves the exact loopback address the listener will take can be bound', async () => {
    await expect(probeLoopbackBind('127.0.0.1', 0)).resolves.toBe(true);
  });

  it('reports the bind probe as unavailable when the port is already taken', async () => {
    // Given a port this process already holds.
    const blocker = createServer();
    const bound = await new Promise<number>((resolve) => {
      blocker.listen(0, '127.0.0.1', () => {
        const address = blocker.address();
        resolve(address && typeof address !== 'string' ? address.port : 0);
      });
    });

    try {
      // When the startup preflight probes that exact address. Then it refuses.
      await expect(probeLoopbackBind('127.0.0.1', bound)).resolves.toBe(false);
      const decision = await Reflect.apply(operatedStartupPreflight, undefined, [{
        browserChromiumPath: chromiumStubPath(),
        browserProfileRoot: profileRootPath(),
      }, { host: '127.0.0.1', port: bound }]);
      expect(decision).toMatchObject({ reason: 'EXECUTION_PORT_UNAVAILABLE' });
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });

  it('NEVER creates a listener when the startup bind probe fails', async () => {
    // Given an execution port whose startup phase refuses the bind.
    const refusing = createFakeExecutionPort({
      startupPreflight: async () => ({ ok: false, reason: 'EXECUTION_PORT_UNAVAILABLE' }),
    });

    // When the real process start is attempted. Then it throws before listening.
    await expect(startJmAgentProcess(environment() as never, { executionPort: refusing }))
      .rejects.toThrow(JmStartupPreflightError);
    expect(refusing.closes()).toBe(1);
  });

  it('runs the startup preflight exactly once and never from readiness', async () => {
    let startupCalls = 0;
    let readinessCalls = 0;
    const counting = createFakeExecutionPort({
      startupPreflight: async () => { startupCalls += 1; return { ok: true }; },
      preflight: () => { readinessCalls += 1; return { ok: true }; },
    });

    const agent = await startJmAgentProcess(
      environment({ SANGFOR_JM_AGENT_PORT: '0' }) as never,
      { executionPort: counting },
    );
    try {
      await call(agent.port, '/ready');
      await call(agent.port, '/ready');
    } finally {
      await agent.drain();
    }

    expect(startupCalls).toBe(1);
    expect(readinessCalls).toBeGreaterThanOrEqual(2);
  });
});
