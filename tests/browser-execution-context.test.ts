import { describe, expect, it, vi } from 'vitest';
import type {
  BrowserExecutionContext,
  BrowserExecutionPort,
  BrowserExecutionRequest,
  BrowserExecutionResult,
} from '../packages/sangfor-browser-contracts/src/index.js';
import {
  BLRO_CONTRACT_VERSION,
  CONTRACT_VERSION_HEADER,
  REMOTE_BROWSER_JOB_PATH,
  REMOTE_EXECUTION_DEADLINE_HEADER,
  buildRemoteJobEnvelope,
  createRemoteBrowserExecutionPort,
  createRemoteBrowserJobHandler,
} from '../packages/sangfor-browser-contracts/src/remote-transport.js';
import { createInProcessJobExecutionPort } from '../packages/sangfor-jm-execution/src/index.js';

const NOW = new Date('2026-08-20T11:00:00.000Z');
const request: BrowserExecutionRequest = {
  schemaVersion: 'browser-execution-request.v1', requestId: 'context-request',
  sessionId: 'context-session', origin: 'http://127.0.0.1:3400',
  operation: { kind: 'observe_console' },
};
const output: BrowserExecutionResult = {
  schemaVersion: 'browser-execution-result.v1', requestId: request.requestId,
  status: 'PASS', mutationAttempted: false, readBack: { status: 'PASS' }, evidence: [],
};

function context(): BrowserExecutionContext {
  const controller = new AbortController();
  return { signal: controller.signal, deadline: '2026-08-20T11:01:00.000Z' };
}

function envelopeOptions() {
  return {
    tenantId: 'tenant-context', projectId: 'project-context',
    runId: 'run-context', stepId: 'step-context', capability: 'cap-context',
    now: () => NOW, ttlMs: 60_000,
  } as const;
}

describe('BrowserExecutionPort cancellation context', () => {
  it('Given an in-process wrapper, When context is supplied, Then the exact signal and deadline reach its delegate', async () => {
    const execute = vi.fn<BrowserExecutionPort['execute']>().mockResolvedValue(output);
    const port = createInProcessJobExecutionPort({ execute }, {
      tenantId: 'tenant-context', projectId: 'project-context', capability: 'cap-context', now: () => NOW,
    });
    const executionContext = context();

    await port.execute(request, executionContext);

    expect(execute).toHaveBeenCalledWith(request, executionContext);
  });

  it('Given a remote client, When context is supplied, Then transport receives cancellation and canonical deadline metadata', async () => {
    const transport = vi.fn(async (remoteRequest, hooks: { markDispatched(): void }) => {
      hooks.markDispatched();
      return { statusCode: 200, body: JSON.stringify(output), request: remoteRequest };
    });
    const port = createRemoteBrowserExecutionPort({
      endpointUrl: `https://jm.example${REMOTE_BROWSER_JOB_PATH}`,
      tls: { cert: 'cert', key: 'key', ca: 'ca', expectedServerFingerprint256: 'a'.repeat(64) },
      envelope: envelopeOptions(), transport,
    });
    const executionContext = context();

    await port.execute(request, executionContext);

    const sent = transport.mock.calls[0]?.[0];
    expect(sent?.signal).toBe(executionContext.signal);
    expect(sent?.deadline).toBe(executionContext.deadline);
    expect(sent?.headers[REMOTE_EXECUTION_DEADLINE_HEADER]).toBe(executionContext.deadline);
  });

  it('Given a remote handler execution context, When a validated job runs, Then the server-side browser port receives it', async () => {
    const execute = vi.fn<BrowserExecutionPort['execute']>().mockResolvedValue(output);
    const handler = createRemoteBrowserJobHandler({
      executor: { execute }, authorizeClient: () => true, now: () => NOW,
    });
    const executionContext = context();
    const envelope = buildRemoteJobEnvelope(request, envelopeOptions());

    const response = await handler.handle({
      client: { fingerprint256: 'client-context', tlsAuthorized: true, raw: {} },
      method: 'POST', urlPath: REMOTE_BROWSER_JOB_PATH,
      bodyText: JSON.stringify(envelope),
      headers: {
        [CONTRACT_VERSION_HEADER]: `${BLRO_CONTRACT_VERSION.major}.${BLRO_CONTRACT_VERSION.minor}`,
      },
      executionContext,
    });

    expect(response.statusCode).toBe(200);
    expect(execute).toHaveBeenCalledWith(request, executionContext);
  });
});
