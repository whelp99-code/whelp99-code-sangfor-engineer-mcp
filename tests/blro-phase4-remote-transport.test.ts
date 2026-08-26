import { describe, expect, it, vi } from 'vitest';
import {
  CONTRACT_VERSION_HEADER,
  REMOTE_BROWSER_JOB_PATH,
  buildRemoteJobEnvelope,
  createRemoteBrowserExecutionPort,
  createRemoteBrowserJobHandler,
  isAuthoritativePass,
  type BrowserExecutionRequest,
} from '../packages/sangfor-browser-contracts/src/index.js';
import {
  remoteTransportDeclaredHeaders,
  remoteTransportDeclaredVersion,
  remoteTransportEnvelopeOptions,
  remoteTransportIssuedAt,
  remoteTransportPassResult,
  remoteTransportRequest,
} from './helpers/remote-transport-fixture.js';
import { TestRemoteJobStore } from './helpers/remote-job-store-fake.js';

describe('Phase 4 remote transport deterministic semantics', () => {
  it('round-trips the unchanged BrowserExecutionPort contract', async () => {
    const request = remoteTransportRequest({ kind: 'observe_console', includeSnapshot: true });
    const execute = vi.fn(async (input: BrowserExecutionRequest) => (
      remoteTransportPassResult(input.requestId, { title: 'Sangfor Mock Console' })
    ));
    const handler = createRemoteBrowserJobHandler({
      executor: { execute }, authorizeClient: () => true,
      jobStore: new TestRemoteJobStore(), now: () => remoteTransportIssuedAt,
    });
    const port = createRemoteBrowserExecutionPort({
      endpointUrl: `https://jm.example${REMOTE_BROWSER_JOB_PATH}`,
      tls: {
        cert: 'cert', key: 'key', ca: 'ca',
        expectedServerFingerprint256: 'a'.repeat(64),
      },
      envelope: remoteTransportEnvelopeOptions(),
      transport: async (remoteRequest, hooks) => {
        hooks.markDispatched();
        const response = await handler.handle({
          client: { fingerprint256: 'client-a', tlsAuthorized: true, raw: {} },
          method: remoteRequest.method,
          urlPath: remoteRequest.url.pathname,
          bodyText: remoteRequest.body,
          headers: remoteRequest.headers,
        });
        return { statusCode: response.statusCode, body: response.bodyText };
      },
    });

    const result = await port.execute(request);
    expect(result.observations).toEqual({ title: 'Sangfor Mock Console' });
    expect(isAuthoritativePass(result)).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('emits the exact canonical contract-version header on every dispatch', async () => {
    const transport = vi.fn(async (_remoteRequest, hooks: { markDispatched(): void }) => {
      hooks.markDispatched();
      return { statusCode: 200, body: JSON.stringify(remoteTransportPassResult('header-check')) };
    });
    const port = createRemoteBrowserExecutionPort({
      endpointUrl: `https://jm.example${REMOTE_BROWSER_JOB_PATH}`,
      tls: { cert: 'cert', key: 'key', ca: 'ca', expectedServerFingerprint256: 'a'.repeat(64) },
      envelope: remoteTransportEnvelopeOptions(),
      transport,
    });

    await port.execute(remoteTransportRequest({ kind: 'observe_console' }, 'header-check'));

    const sent = transport.mock.calls[0]?.[0].headers ?? {};
    expect(Object.keys(sent)).toContain(CONTRACT_VERSION_HEADER);
    expect(sent[CONTRACT_VERSION_HEADER]).toBe(remoteTransportDeclaredVersion);
    expect(sent[CONTRACT_VERSION_HEADER]).toBe(sent[CONTRACT_VERSION_HEADER]?.trim());
  });

  it('returns a retained fresh-capability duplicate without redispatching', async () => {
    const request = remoteTransportRequest({ kind: 'observe_console' }, 'job-duplicate');
    const execute = vi.fn(async (input: BrowserExecutionRequest) => (
      remoteTransportPassResult(input.requestId, { calls: String(execute.mock.calls.length) })
    ));
    const jobStore = new TestRemoteJobStore();
    const handler = createRemoteBrowserJobHandler({
      executor: { execute }, authorizeClient: () => true,
      jobStore, now: () => remoteTransportIssuedAt,
    });
    const input = {
      client: { fingerprint256: 'client-a', tlsAuthorized: true, raw: {} },
      method: 'POST', urlPath: REMOTE_BROWSER_JOB_PATH,
      bodyText: JSON.stringify(buildRemoteJobEnvelope(request, remoteTransportEnvelopeOptions())),
      headers: remoteTransportDeclaredHeaders,
    };

    const first = await handler.handle(input);
    const second = await handler.handle({
      ...input,
      bodyText: JSON.stringify(buildRemoteJobEnvelope(request, remoteTransportEnvelopeOptions())),
    });

    expect(first.bodyText).toBe(second.bodyText);
    expect(jobStore.retentions).toEqual(['job-duplicate']);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('uses a remote-job authority seam supplied by the host', async () => {
    const store = new TestRemoteJobStore();
    const request = remoteTransportRequest({ kind: 'observe_console' }, 'job-durable');
    const execute = vi.fn(async (input: BrowserExecutionRequest) => (
      remoteTransportPassResult(input.requestId)
    ));
    const handler = createRemoteBrowserJobHandler({
      executor: { execute }, authorizeClient: () => true,
      jobStore: store, now: () => remoteTransportIssuedAt,
    });
    const input = {
      client: { fingerprint256: 'client-a', tlsAuthorized: true, raw: {} },
      method: 'POST', urlPath: REMOTE_BROWSER_JOB_PATH,
      bodyText: JSON.stringify(buildRemoteJobEnvelope(request, remoteTransportEnvelopeOptions())),
      headers: remoteTransportDeclaredHeaders,
    };

    await handler.handle(input);
    await handler.handle({
      ...input,
      bodyText: JSON.stringify(buildRemoteJobEnvelope(request, remoteTransportEnvelopeOptions())),
    });

    expect(store.retentions).toEqual(['job-durable']);
    expect(execute).toHaveBeenCalledOnce();
  });
});
