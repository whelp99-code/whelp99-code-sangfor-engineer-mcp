import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BLRO_CONTRACT_VERSION,
  CONTRACT_VERSION_HEADER,
  REMOTE_BROWSER_JOB_PATH,
  buildRemoteJobEnvelope,
  formatContractVersion,
} from '../packages/sangfor-browser-contracts/src/index.js';
import {
  RECEIPT_HEADER,
  RECEIPT_ID_HEADER,
} from '../packages/sangfor-jm-agent/src/index.js';
import { composeJmAgent, JmAgentStartupError } from '../apps/jm-browser-agent/src/composition.js';
import { createJmAgentServer, type JmAgentServer } from '../apps/jm-browser-agent/src/server.js';
import {
  JmStartupPreflightError, buildCoordinator, exitCodeFor, installSignalHandlers,
  startJmAgentProcess,
} from '../apps/jm-browser-agent/src/process.js';
import {
  operatedReadinessPreflight, operatedStartupPreflight, probeLoopbackBind,
} from '../apps/jm-browser-agent/src/operated-execution.js';
import { checkServerIdentity } from '../packages/sangfor-jm-agent/src/index.js';
import {
  JM_DEVICE_DIGEST,
  JM_INSTALLATION_ID,
  JM_JOURNAL_GENESIS,
  JM_ORIGIN,
  JM_PROJECT_ID,
  JM_SESSION_ID,
  JM_TENANT_ID,
  browserRequest,
  buildAuthorityReceipt,
  buildGrantSnapshot,
  createFakeExecutionPort,
  createJmSigningMaterial,
  createJmTlsMaterial,
  initialiseTestJournal,
  mintTaskCapability,
  type FakeExecutionPort,
  type JmSigningMaterial,
  type JmTlsMaterial,
} from './helpers/jm-agent-fixture.js';
import { ExactSignal } from './helpers/exact-signal.js';

let root: string;
let tls: JmTlsMaterial;
let signing: JmSigningMaterial;
let snapshotPath: string;
let profileRoot: string;
let chromiumStub: string;

/** An operator-initialised journal root; production never creates one. */
function freshJournalRoot(): string {
  const root = join(mkdtempSync(join(tmpdir(), 'jm-journal-')), 'jm');
  initialiseTestJournal(root, { journalEpoch: 7, genesisDigest: JM_JOURNAL_GENESIS });
  return root;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'jm-agent-tls-'));
  tls = createJmTlsMaterial(root);
  signing = createJmSigningMaterial(root);
  profileRoot = join(root, 'profile');
  mkdirSync(profileRoot, { recursive: true, mode: 0o700 });
  chmodSync(profileRoot, 0o700);
  // A REAL regular executable; the preflight rejects symlinked browser paths.
  chromiumStub = join(root, 'chromium-stub');
  writeFileSync(chromiumStub, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  snapshotPath = join(root, 'snapshot.jws');
  writeFileSync(snapshotPath, buildGrantSnapshot(signing));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function environment(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    SANGFOR_JM_AGENT_BIND_HOST: '127.0.0.1',
    // Ephemeral port: concurrent checkouts of this suite cannot collide.
    SANGFOR_JM_AGENT_PORT: '0',
    SANGFOR_JM_AGENT_TLS_CERT_PATH: tls.serverCertPath,
    SANGFOR_JM_AGENT_TLS_KEY_PATH: tls.serverKeyPath,
    SANGFOR_JM_AGENT_TLS_CLIENT_CA_PATH: tls.caPath,
    SANGFOR_JM_AGENT_BLRO_CLIENT_FINGERPRINT_SHA256: tls.clientFingerprint256,
    SANGFOR_JM_AGENT_BLRO_CLIENT_SUBJECT_CN: 'blro-control-tower',
    SANGFOR_JM_AGENT_BLRO_CLIENT_SERIAL: tls.clientSerial,
    SANGFOR_JM_AGENT_BLRO_CLIENT_SAN_URI: tls.clientSubjectAltName,
    SANGFOR_JM_AGENT_BLRO_CLIENT_ISSUER_CN: 'Task26-Trusted-CA',
    SANGFOR_JM_AGENT_VERIFY_KEY_RING_PATH: signing.keyRingPath,
    SANGFOR_JM_AGENT_GRANT_SNAPSHOT_PATH: snapshotPath,
    SANGFOR_JM_AGENT_JOURNAL_ROOT: freshJournalRoot(),
    SANGFOR_JM_AGENT_TENANT_ID: JM_TENANT_ID,
    SANGFOR_JM_AGENT_PROJECT_ID: JM_PROJECT_ID,
    SANGFOR_JM_AGENT_INSTALLATION_ID: JM_INSTALLATION_ID,
    SANGFOR_JM_AGENT_DEVICE_BINDING_DIGEST: JM_DEVICE_DIGEST,
    SANGFOR_JM_AGENT_BROWSER_PROFILE_REF: 'task26-profile',
    SANGFOR_JM_AGENT_BROWSER_PROFILE_ROOT: profileRoot,
    SANGFOR_JM_AGENT_BROWSER_SESSION_ID: JM_SESSION_ID,
    SANGFOR_JM_AGENT_BROWSER_CHROMIUM_PATH: '/usr/bin/chromium',
    SANGFOR_JM_AGENT_ALLOWED_ORIGIN: JM_ORIGIN,
    SANGFOR_JM_AGENT_JOB_TIMEOUT_MS: '30000',
    SANGFOR_JM_AGENT_DRAIN_DEADLINE_MS: '5000',
    SANGFOR_JM_AGENT_SNAPSHOT_MAX_AGE_MS: '900000',
    ...overrides,
  };
}

type Response = { readonly status: number; readonly body: string };

type CallOptions = {
  readonly clientCert?: boolean;
  readonly foreign?: boolean;
  readonly body?: string;
  readonly receipt?: string;
  readonly receiptId?: string;
  readonly jobId?: string;
};

function call(port: number, path: string, options: CallOptions = {}): Promise<Response> {
  const identity: RequestOptions = options.foreign
    ? { cert: readFileSync(tls.foreignClientCertPath), key: readFileSync(tls.foreignClientKeyPath) }
    : options.clientCert === false
      ? {}
      : { cert: readFileSync(tls.clientCertPath), key: readFileSync(tls.clientKeyPath) };
  return new Promise((resolve, reject) => {
    const outgoing = httpsRequest({
      host: '127.0.0.1',
      port,
      path,
      method: options.body === undefined ? 'GET' : 'POST',
      ca: readFileSync(tls.caPath),
      servername: 'localhost',
      headers: {
        [CONTRACT_VERSION_HEADER]: formatContractVersion(BLRO_CONTRACT_VERSION),
        ...(options.receipt === undefined ? {} : { [RECEIPT_HEADER]: options.receipt }),
        ...(options.receiptId === undefined ? {} : { [RECEIPT_ID_HEADER]: options.receiptId }),
        ...(options.jobId === undefined ? {} : { 'x-sangfor-job-id': options.jobId }),
      },
      ...identity,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    outgoing.once('error', reject);
    if (options.body !== undefined) outgoing.write(options.body);
    outgoing.end();
  });
}

/** A complete, correctly bound dispatch: envelope body plus its receipt. */
function signedDispatch(overrides: {
  readonly jti?: string;
  readonly fingerprint?: string;
  readonly receiptPatch?: Parameters<typeof buildAuthorityReceipt>[2];
} = {}) {
  const request = browserRequest();
  const jti = overrides.jti ?? `jti-${request.requestId}`;
  const capability = mintTaskCapability(signing, request, { jti, jobId: request.requestId });
  const envelope = buildRemoteJobEnvelope(request, {
    tenantId: JM_TENANT_ID,
    projectId: JM_PROJECT_ID,
    capability,
  });
  const receipt = buildAuthorityReceipt(signing, {
    request,
    jobId: envelope.jobId,
    capability,
    capabilityJti: jti,
    clientFingerprint: overrides.fingerprint ?? tls.clientFingerprint256,
  }, overrides.receiptPatch ?? {});
  const payload = receipt.split('.')[0] ?? '';
  const decoded: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  const receiptId = (decoded as { readonly receiptId: string }).receiptId;
  return { body: JSON.stringify(envelope), receipt, receiptId, jobId: envelope.jobId, request };
}

type Harness = {
  readonly port: number;
  readonly server: JmAgentServer;
  readonly composition: ReturnType<typeof composeJmAgent>;
  readonly fake: FakeExecutionPort;
};

async function withServer(
  overrides: Record<string, string>,
  body: (harness: Harness) => Promise<void>,
  fake: FakeExecutionPort = createFakeExecutionPort(),
): Promise<void> {
  const composition = composeJmAgent(environment(overrides), { executionPort: fake });
  const server = createJmAgentServer(composition);
  const port = await server.listen();
  try {
    await body({ port, server, composition, fake });
  } finally {
    await server.close();
  }
}

describe('JM agent mTLS transport and per-dispatch authority', () => {
  it('serves process-only /live and dependency-aware /ready', async () => {
    await withServer({}, async ({ port }) => {
      expect((await call(port, '/live')).status).toBe(200);
      const ready = await call(port, '/ready');
      expect(ready.status).toBe(200);
      expect(JSON.parse(ready.body)).toMatchObject({
        ok: true,
        checks: { grantSnapshot: { ok: true }, journal: { ok: true } },
      });
    });
  });

  it('fails the handshake without a client certificate or from a foreign CA', async () => {
    await withServer({}, async ({ port }) => {
      await expect(call(port, '/live', { clientCert: false })).rejects.toThrow();
      await expect(call(port, '/live', { foreign: true })).rejects.toThrow();
    });
  });

  it('dispatches a signed per-request job to the executor exactly once', async () => {
    await withServer({}, async ({ port, fake }) => {
      const dispatch = signedDispatch();

      const response = await call(port, REMOTE_BROWSER_JOB_PATH, {
        body: dispatch.body, receipt: dispatch.receipt,
        receiptId: dispatch.receiptId, jobId: dispatch.jobId,
      });

      expect(response.status).toBe(200);
      expect(fake.calls()).toBe(1);
      // JM observes; it never returns a PASS.
      expect(JSON.parse(response.body)).toMatchObject({ status: 'INDETERMINATE' });
    });
  });

  it('refuses a job with no receipt, and calls no executor', async () => {
    await withServer({}, async ({ port, fake }) => {
      const dispatch = signedDispatch();

      const response = await call(port, REMOTE_BROWSER_JOB_PATH, {
        body: dispatch.body, jobId: dispatch.jobId,
      });

      expect(response.status).toBe(403);
      expect(fake.calls()).toBe(0);
    });
  });

  it('refuses a receipt bound to another client fingerprint or another key', async () => {
    await withServer({}, async ({ port, fake }) => {
      const wrongFingerprint = signedDispatch({ fingerprint: 'a'.repeat(64) });
      const foreignKey = signedDispatch({
        receiptPatch: { privateKey: signing.foreignPrivateKey },
      });

      for (const dispatch of [wrongFingerprint, foreignKey]) {
        const response = await call(port, REMOTE_BROWSER_JOB_PATH, {
          body: dispatch.body, receipt: dispatch.receipt,
        receiptId: dispatch.receiptId, jobId: dispatch.jobId,
        });
        expect(response.status).toBe(403);
      }
      expect(fake.calls()).toBe(0);
    });
  });

  it('refuses a replay of the same receipt without a second executor call', async () => {
    await withServer({}, async ({ port, fake }) => {
      const dispatch = signedDispatch();
      const send = () => call(port, REMOTE_BROWSER_JOB_PATH, {
        body: dispatch.body, receipt: dispatch.receipt,
        receiptId: dispatch.receiptId, jobId: dispatch.jobId,
      });

      const first = await send();
      const second = await send();

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(JSON.parse(second.body)).toMatchObject({ status: 'INDETERMINATE' });
      expect(fake.calls()).toBe(1);
    });
  });

  it('refuses a duplicate dispatch after a RESTART using the same journal', async () => {
    // One operator-initialised journal shared across the simulated restart.
    const journalRoot = freshJournalRoot();
    const dispatch = signedDispatch();

    await withServer({ SANGFOR_JM_AGENT_JOURNAL_ROOT: journalRoot }, async ({ port, fake }) => {
      const first = await call(port, REMOTE_BROWSER_JOB_PATH, {
        body: dispatch.body, receipt: dispatch.receipt,
        receiptId: dispatch.receiptId, jobId: dispatch.jobId,
      });
      expect(first.status).toBe(200);
      expect(fake.calls()).toBe(1);
    });

    // A brand-new process on the SAME journal must not dispatch again.
    await withServer({ SANGFOR_JM_AGENT_JOURNAL_ROOT: journalRoot }, async ({ port, fake }) => {
      const replay = await call(port, REMOTE_BROWSER_JOB_PATH, {
        body: dispatch.body, receipt: dispatch.receipt,
        receiptId: dispatch.receiptId, jobId: dispatch.jobId,
      });
      expect(replay.status).toBe(200);
      expect(JSON.parse(replay.body)).toMatchObject({ status: 'INDETERMINATE' });
      expect(fake.calls()).toBe(0);
    });
  });

  it('serves multiple distinct valid receipts sequentially', async () => {
    await withServer({}, async ({ port, fake }) => {
      for (let index = 0; index < 3; index += 1) {
        const dispatch = signedDispatch();
        const response = await call(port, REMOTE_BROWSER_JOB_PATH, {
          body: dispatch.body, receipt: dispatch.receipt,
        receiptId: dispatch.receiptId, jobId: dispatch.jobId,
        });
        expect(response.status, `dispatch ${String(index)}`).toBe(200);
      }
      expect(fake.calls()).toBe(3);
    });
  });

  it('never leaks key, certificate or path bytes in any response', async () => {
    await withServer({}, async ({ port }) => {
      const bodies = [
        (await call(port, '/live')).body,
        (await call(port, '/ready')).body,
        (await call(port, REMOTE_BROWSER_JOB_PATH, { body: '{}' })).body,
        (await call(port, '/nope')).body,
      ].join('\n');

      expect(bodies).not.toContain('PRIVATE KEY');
      expect(bodies).not.toContain('BEGIN CERTIFICATE');
      expect(bodies).not.toContain(root);
    });
  });
});

describe('stale and revoked dynamic grant lifecycle', () => {
  it('starts, serves TLS /live, but reports /ready 503 and refuses jobs', async () => {
    const revokedPath = join(root, 'revoked-snapshot.jws');
    writeFileSync(revokedPath, buildGrantSnapshot(signing, { state: 'revoked' }));
    const stalePath = join(root, 'stale-snapshot.jws');
    writeFileSync(stalePath, buildGrantSnapshot(signing, {
      issuedAt: new Date(Date.now() - 1_800_000),
    }));

    for (const snapshot of [revokedPath, stalePath]) {
      await withServer({ SANGFOR_JM_AGENT_GRANT_SNAPSHOT_PATH: snapshot }, async ({ port, fake }) => {
        // The static gate did NOT fail: the process is up and /live answers.
        const live = await call(port, '/live');
        const ready = await call(port, '/ready');
        const dispatch = signedDispatch();
        const job = await call(port, REMOTE_BROWSER_JOB_PATH, {
          body: dispatch.body, receipt: dispatch.receipt,
        receiptId: dispatch.receiptId, jobId: dispatch.jobId,
        });

        expect(live.status, snapshot).toBe(200);
        expect(ready.status, snapshot).toBe(503);
        expect(JSON.parse(ready.body)).toMatchObject({
          checks: { grantSnapshot: { ok: false, reason: 'GRANT_SNAPSHOT_INVALID' } },
        });
        expect(job.status, snapshot).toBe(503);
        expect(fake.calls(), snapshot).toBe(0);
      });
    }
  });
});

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
        SANGFOR_JM_AGENT_TLS_CERT_PATH: tls.clientAuthOnlyCertPath,
        SANGFOR_JM_AGENT_TLS_KEY_PATH: tls.clientAuthOnlyKeyPath,
      },
      {
        SANGFOR_JM_AGENT_TLS_CERT_PATH: tls.foreignServerCertPath,
        SANGFOR_JM_AGENT_TLS_KEY_PATH: tls.foreignServerKeyPath,
      },
      {
        SANGFOR_JM_AGENT_TLS_CERT_PATH: tls.nonLoopbackServerCertPath,
        SANGFOR_JM_AGENT_TLS_KEY_PATH: tls.nonLoopbackServerKeyPath,
      },
    ]) {
      expect(() => composeJmAgent(environment(patch), {
        executionPort: createFakeExecutionPort(),
      }), JSON.stringify(patch)).toThrow(JmAgentStartupError);
    }
  });

  it('never includes secret bytes in the startup refusal message', () => {
    try {
      composeJmAgent(environment({ SANGFOR_JM_AGENT_TLS_KEY_PATH: tls.otherServerKeyPath }), {
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
      browserChromiumPath: chromiumStub,
      browserProfileRoot: profileRoot,
    } as unknown as Parameters<typeof operatedReadinessPreflight>[0];

    expect(operatedReadinessPreflight(base).ok).toBe(true);
    expect(operatedReadinessPreflight({
      ...base, browserChromiumPath: '/nonexistent/chromium',
    } as typeof base)).toMatchObject({ reason: 'EXECUTION_CHROMIUM_MISSING' });
    const notExecutable = join(root, 'chromium-noexec');
    writeFileSync(notExecutable, 'x', { mode: 0o600 });
    expect(operatedReadinessPreflight({
      ...base, browserChromiumPath: notExecutable,
    } as typeof base)).toMatchObject({ reason: 'EXECUTION_CHROMIUM_NOT_EXECUTABLE' });
    expect(operatedReadinessPreflight({
      ...base, browserProfileRoot: '/nonexistent/profile',
    } as typeof base)).toMatchObject({ reason: 'EXECUTION_PROFILE_MISSING' });
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
      const decision = await operatedStartupPreflight({
        browserChromiumPath: chromiumStub,
        browserProfileRoot: profileRoot,
      } as unknown as Parameters<typeof operatedStartupPreflight>[0],
      { host: '127.0.0.1', port: bound });
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

describe('certificate authority validity', () => {
  // See the note in the runtime suite: openssl notBefore is whole-second, so a
  // same-second wall clock can race the mint boundary.
  const now = new Date(Date.now() + 60_000);

  it('refuses an expired or not-yet-valid CA even when the leaf verifies', () => {
    for (const [caPath, reason] of [
      [tls.expiredCaPath, 'SERVER_CA_EXPIRED'],
      [tls.futureCaPath, 'SERVER_CA_NOT_YET_VALID'],
    ] as const) {
      const decision = checkServerIdentity({
        certPath: tls.serverCertPath, keyPath: tls.serverKeyPath, caPath, now,
      });

      expect(decision.ok, reason).toBe(false);
      if (decision.ok) continue;
      expect(decision.reason).toBe(reason);
    }
  });

  it('refuses a non-CA leaf presented as the trust anchor', () => {
    const decision = checkServerIdentity({
      certPath: tls.serverCertPath, keyPath: tls.serverKeyPath,
      caPath: tls.clientCertPath, now,
    });

    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.reason).toBe('SERVER_CA_NOT_A_CA');
  });

  it('refuses an expired CA before any listener exists', () => {
    expect(() => composeJmAgent(environment({
      SANGFOR_JM_AGENT_TLS_CLIENT_CA_PATH: tls.expiredCaPath,
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
