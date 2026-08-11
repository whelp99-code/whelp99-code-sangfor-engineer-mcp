import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  BrowserExecutionPort,
  BrowserExecutionResult,
} from '../packages/sangfor-browser-contracts/src/index.js';
import {
  closeOperatorSession,
  executeLiveConsoleAction,
  getOperatorSession,
  killSession,
  readLiveConsoleState,
  startOperatorSession,
} from '../packages/sangfor-operator/src/index.js';

const originalAllowReal = process.env.SANGFOR_ALLOW_REAL_EXECUTION;

function fakePort(): BrowserExecutionPort {
  return {
    execute: vi.fn(async (request): Promise<BrowserExecutionResult> => ({
      schemaVersion: 'browser-execution-result.v1',
      requestId: request.requestId,
      status: 'PASS',
      mutationAttempted: false,
      readBack: { status: 'PASS' },
      observations: {
        title: 'Mock Sangfor HCI Console',
        url: 'http://127.0.0.1:3400/hci',
        text: 'Dashboard',
      },
      evidence: [],
    })),
  };
}

describe('operator browser execution port', () => {
  const sessionIds: string[] = [];

  afterEach(() => {
    for (const sessionId of sessionIds.splice(0)) killSession(sessionId);
    if (originalAllowReal === undefined) delete process.env.SANGFOR_ALLOW_REAL_EXECUTION;
    else process.env.SANGFOR_ALLOW_REAL_EXECUTION = originalAllowReal;
  });

  it.each([
    '9333@attacker.example:80/',
    0,
    65_536,
    9333.5,
  ])('rejects hostile or invalid CDP port %s', (cdpPort) => {
    expect(() => startOperatorSession({
      product: 'HCI',
      mode: 'lab',
      browser: { useLocalBrowser: true, cdpPort: cdpPort as never },
    })).toThrow(/CDP_PORT_INVALID/);
  });

  it('removes credentials and the session record when killed', () => {
    const session = startOperatorSession({
      product: 'HCI',
      mode: 'lab',
      credentials: { username: 'qa-admin', password: 'qa-secret' },
    });

    const killed = killSession(session.id);

    expect(killed.credentials).toBeUndefined();
    expect(() => getOperatorSession(session.id)).toThrow(/Unknown session/);
  });

  it('closes the browser port before deleting a live session', async () => {
    const port = fakePort();
    const session = startOperatorSession({
      product: 'HCI',
      mode: 'lab',
      targetUrl: 'http://127.0.0.1:3400/hci',
    });

    const closed = await closeOperatorSession(session.id, port);

    expect(closed.id).toBe(session.id);
    expect(port.execute).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: session.id,
      operation: { kind: 'close_session' },
    }));
    expect(() => getOperatorSession(session.id)).toThrow(/Unknown session/);
  });

  it('routes a live read through the injected port', async () => {
    const port = fakePort();
    const session = startOperatorSession({
      product: 'HCI',
      mode: 'lab',
      targetUrl: 'http://127.0.0.1:3400/hci',
      browser: { startIfMissing: false },
    });
    sessionIds.push(session.id);

    const state = await readLiveConsoleState({
      sessionId: session.id,
      executionPort: port,
    });

    expect(port.execute).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: session.id,
      origin: 'http://127.0.0.1:3400',
      operation: { kind: 'observe_console', includeSnapshot: true },
    }));
    expect(state).toMatchObject({
      title: 'Mock Sangfor HCI Console',
      url: 'http://127.0.0.1:3400/hci',
      browser: 'jm-local-port',
    });
  });

  it('routes a dry-run live action without passing approval material', async () => {
    const port = fakePort();
    const session = startOperatorSession({
      product: 'HCI',
      mode: 'lab',
      targetUrl: 'http://127.0.0.1:3400/hci',
    });
    sessionIds.push(session.id);

    const output = await executeLiveConsoleAction({
      sessionId: session.id,
      action: { type: 'screenshot', target: 'current-page', dryRun: true },
      executionPort: port,
    });

    expect(output.ok).toBe(true);
    const request = vi.mocked(port.execute).mock.calls[0]?.[0];
    expect(request).toBeDefined();
    expect(request).not.toHaveProperty('approval');
    expect(JSON.stringify(request)).not.toContain('approvalToken');
  });

  it('does not map a non-authoritative PASS to ok', async () => {
    const port = fakePort();
    vi.mocked(port.execute).mockResolvedValue({
      schemaVersion: 'browser-execution-result.v1',
      requestId: 'browser-action-non-authoritative',
      status: 'PASS',
      mutationAttempted: false,
      readBack: { status: 'FAIL' },
      evidence: [],
    });
    const session = startOperatorSession({
      product: 'HCI',
      mode: 'lab',
      targetUrl: 'http://127.0.0.1:3400/hci',
    });
    sessionIds.push(session.id);

    const output = await executeLiveConsoleAction({
      sessionId: session.id,
      action: { type: 'screenshot', target: 'current-page', dryRun: true },
      executionPort: port,
    });

    expect(output.ok).toBe(false);
  });

  it('blocks a real action before dispatch when the local gate is disabled', async () => {
    delete process.env.SANGFOR_ALLOW_REAL_EXECUTION;
    const port = fakePort();
    const session = startOperatorSession({
      product: 'HCI',
      mode: 'lab',
      targetUrl: 'http://127.0.0.1:3400/hci',
    });
    sessionIds.push(session.id);

    await expect(executeLiveConsoleAction({
      sessionId: session.id,
      action: { type: 'click', target: 'Apply', dryRun: false },
      executionPort: port,
    })).rejects.toThrow(/SANGFOR_ALLOW_REAL_EXECUTION/);
    expect(port.execute).not.toHaveBeenCalled();
  });
});
