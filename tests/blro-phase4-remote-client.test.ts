import { describe, expect, it, vi } from 'vitest';
import {
  REMOTE_BROWSER_JOB_PATH,
  REMOTE_TRANSPORT_ERROR_CODES,
  createRemoteBrowserExecutionPort,
  isAuthoritativePass,
} from '../packages/sangfor-browser-contracts/src/index.js';
import {
  remoteTransportEnvelopeOptions,
  remoteTransportPassResult,
  remoteTransportRequest,
} from './helpers/remote-transport-fixture.js';

const tls = {
  cert: 'cert', key: 'key', ca: 'ca',
  expectedServerFingerprint256: 'a'.repeat(64),
} as const;

function portWith(
  transport: Parameters<typeof createRemoteBrowserExecutionPort>[0]['transport'],
) {
  return createRemoteBrowserExecutionPort({
    endpointUrl: `https://jm.example${REMOTE_BROWSER_JOB_PATH}`,
    tls,
    envelope: remoteTransportEnvelopeOptions(),
    ...(transport ? { transport } : {}),
  });
}

describe('Phase 4 remote client uncertainty semantics', () => {
  it('maps post-dispatch loss to INDETERMINATE and never retries', async () => {
    // Given transport loss after the wire dispatch event.
    const transport = vi.fn(async (_request, hooks: { markDispatched(): void }) => {
      hooks.markDispatched();
      throw new TypeError('socket hang up');
    });

    // When a mutation request executes.
    const result = await portWith(transport).execute(remoteTransportRequest({
      kind: 'perform_console_action',
      action: { type: 'click', target: 'Apply', dryRun: false },
    }));

    // Then uncertainty is explicit and the transport is not retried.
    expect(transport).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      status: 'INDETERMINATE', mutationAttempted: true,
      readBack: { status: 'INDETERMINATE' },
      error: { code: REMOTE_TRANSPORT_ERROR_CODES.DISCONNECT_AFTER_DISPATCH },
    });
    expect(isAuthoritativePass(result)).toBe(false);
  });

  it('maps pre-dispatch loss to REFUSED without claiming mutation', async () => {
    // Given transport loss before the dispatch marker.
    const transport = vi.fn(async () => { throw new TypeError('connect ECONNREFUSED'); });

    // When a read request executes.
    const result = await portWith(transport).execute(
      remoteTransportRequest({ kind: 'observe_console' }),
    );

    // Then no mutation is claimed and no retry occurs.
    expect(transport).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      status: 'REFUSED', mutationAttempted: false,
      error: { code: REMOTE_TRANSPORT_ERROR_CODES.TRANSPORT_UNAVAILABLE },
    });
  });

  it('preserves a typed contract-version refusal returned by the remote endpoint', async () => {
    // Given the endpoint definitively refuses this dispatch at protocol preflight.
    const transport = vi.fn(async (_request, hooks: { markDispatched(): void }) => {
      hooks.markDispatched();
      return {
        statusCode: 426,
        body: JSON.stringify({
          schemaVersion: 'browser-remote-error.v1',
          error: {
            code: 'REMOTE_CONTRACT_VERSION_UNSUPPORTED',
            message: 'PEER_CONTRACT_AHEAD: upgrade BLRO first.',
          },
        }),
      };
    });

    // When the public BrowserExecutionPort receives the refusal.
    const result = await portWith(transport).execute(
      remoteTransportRequest({ kind: 'observe_console' }),
    );

    // Then the public result preserves the machine-consumed refusal code.
    expect(result).toMatchObject({
      status: 'REFUSED',
      mutationAttempted: false,
      error: { code: 'REMOTE_CONTRACT_VERSION_UNSUPPORTED' },
    });
  });

  it('treats truncated 2xx and requestId mismatch as INDETERMINATE', async () => {
    // Given machine-invalid success responses after dispatch.
    const request = remoteTransportRequest({ kind: 'observe_console' });
    const responses = [
      { statusCode: 200, body: '{"status":"PASS"' },
      { statusCode: 200, body: JSON.stringify(remoteTransportPassResult('another-request')) },
    ];

    // When each response is mapped.
    const results = await Promise.all(responses.map((response) => portWith(
      async (_remoteRequest, hooks) => { hooks.markDispatched(); return response; },
    ).execute(request)));

    // Then neither malformed response can become PASS.
    for (const result of results) {
      expect(result).toMatchObject({
        status: 'INDETERMINATE',
        error: { code: REMOTE_TRANSPORT_ERROR_CODES.DISCONNECT_AFTER_DISPATCH },
      });
    }
  });

  it('refuses non-HTTPS configuration and schema-invalid requests before dispatch', async () => {
    // Given an insecure endpoint and a strict valid HTTPS port.
    expect(() => createRemoteBrowserExecutionPort({
      endpointUrl: `http://jm.example${REMOTE_BROWSER_JOB_PATH}`,
      tls,
      envelope: remoteTransportEnvelopeOptions(),
    })).toThrow(/https/iu);
    const transport = vi.fn();
    const port = portWith(transport);

    // When an invalid path-bearing request ID is submitted.
    await expect(port.execute({
      schemaVersion: 'browser-execution-request.v1',
      requestId: '../escape',
      sessionId: 'session',
      origin: 'http://127.0.0.1:3400',
      operation: { kind: 'observe_console' },
    })).rejects.toThrow();

    // Then no transport dispatch occurs.
    expect(transport).not.toHaveBeenCalled();
  });
});
