import { describe, expect, it, vi } from 'vitest';
import type {
  BrowserExecutionRequest,
  BrowserExecutionResult,
} from '../packages/sangfor-browser-contracts/src/index.js';
import {
  createLocalJmExecutionPort,
  type JmBrowserDriver,
  type LocalJmSession,
} from '../packages/sangfor-jm-execution/src/index.js';

const session: LocalJmSession = {
  sessionId: 'session-local-1',
  origin: 'http://127.0.0.1:3400',
  mode: 'lab',
};

const request = (
  operation: BrowserExecutionRequest['operation'],
): BrowserExecutionRequest => ({
  schemaVersion: 'browser-execution-request.v1',
  requestId: `request-${operation.kind}`,
  sessionId: session.sessionId,
  origin: session.origin,
  operation,
});

const result = (
  requestId: string,
  overrides: Partial<BrowserExecutionResult> = {},
): BrowserExecutionResult => ({
  schemaVersion: 'browser-execution-result.v1',
  requestId,
  status: 'PASS',
  mutationAttempted: false,
  readBack: { status: 'PASS' },
  evidence: [],
  ...overrides,
});

describe('local JM browser execution port', () => {
  it('resolves the local session and dispatches an observation', async () => {
    const execute = vi.fn<JmBrowserDriver['execute']>()
      .mockResolvedValue(result('request-observe_console', {
        observations: { title: 'Sangfor Mock Console' },
      }));
    const port = createLocalJmExecutionPort({
      resolveSession: (sessionId) => sessionId === session.sessionId ? session : undefined,
      driver: { execute, closeSession: vi.fn() },
    });
    const input = request({ kind: 'observe_console', includeSnapshot: true });

    const output = await port.execute(input);

    expect(output.status).toBe('PASS');
    expect(execute).toHaveBeenCalledWith(session, input);
  });

  it('refuses an origin that differs from the resolved session', async () => {
    const execute = vi.fn<JmBrowserDriver['execute']>();
    const port = createLocalJmExecutionPort({
      resolveSession: () => session,
      driver: { execute, closeSession: vi.fn() },
    });

    const output = await port.execute({
      ...request({ kind: 'observe_console' }),
      origin: 'https://other.example',
    });

    expect(output.status).toBe('REFUSED');
    expect(output.error?.code).toBe('SESSION_ORIGIN_MISMATCH');
    expect(execute).not.toHaveBeenCalled();
  });

  it('downgrades a mutation without PASS read-back to INDETERMINATE', async () => {
    const execute = vi.fn<JmBrowserDriver['execute']>()
      .mockResolvedValue(result('request-perform_console_action', {
        mutationAttempted: true,
        readBack: { status: 'INDETERMINATE' },
      }));
    const port = createLocalJmExecutionPort({
      resolveSession: () => session,
      driver: { execute, closeSession: vi.fn() },
    });

    const output = await port.execute(request({
      kind: 'perform_console_action',
      action: { type: 'click', target: 'Apply', dryRun: false },
    }));

    expect(output.status).toBe('INDETERMINATE');
    expect(output.mutationAttempted).toBe(true);
  });

  it('preserves possible mutation when a real action driver fails after dispatch', async () => {
    const port = createLocalJmExecutionPort({
      resolveSession: () => session,
      driver: {
        execute: vi.fn().mockRejectedValue(new Error('response wait failed after click')),
        closeSession: vi.fn(),
      },
    });

    const output = await port.execute(request({
      kind: 'perform_console_action',
      action: { type: 'click', target: 'Apply', dryRun: false },
    }));

    expect(output.status).toBe('INDETERMINATE');
    expect(output.mutationAttempted).toBe(true);
    expect(output.error?.code).toBe('JM_BROWSER_MUTATION_INDETERMINATE');
  });

  it('closes a local session without browser data in the result', async () => {
    const closeSession = vi.fn<JmBrowserDriver['closeSession']>()
      .mockResolvedValue(undefined);
    const port = createLocalJmExecutionPort({
      resolveSession: () => session,
      driver: { execute: vi.fn(), closeSession },
    });

    const output = await port.execute(request({ kind: 'close_session' }));

    expect(closeSession).toHaveBeenCalledWith(session);
    expect(output).toEqual(result('request-close_session'));
  });
});
