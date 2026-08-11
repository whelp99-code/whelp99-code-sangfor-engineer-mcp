import { beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  BrowserExecutionRequest,
  BrowserExecutionPort,
  BrowserExecutionResult,
} from '../packages/sangfor-browser-contracts/src/index.js';
import type { ObserverTransport } from '../packages/sangfor-observer/src/index.js';
import { getOperatorSession } from '../packages/sangfor-operator/src/index.js';

process.env.MCP_NO_SERVE = '1';

let configureJmBrowserRuntime: (deps: {
  executionPort: BrowserExecutionPort;
  observerTransport: ObserverTransport;
  materializeArtifact?: (artifactRef: string, destinationPath: string) => Promise<void>;
}) => void;
let getToolHandler: (name: string) => ((args: any) => unknown) | undefined;

function fakePort(onExecute?: (request: BrowserExecutionRequest) => void): BrowserExecutionPort {
  return {
    execute: vi.fn(async (request): Promise<BrowserExecutionResult> => {
      onExecute?.(request);
      return {
        schemaVersion: 'browser-execution-result.v1',
        requestId: request.requestId,
        status: 'PASS',
        mutationAttempted: false,
        readBack: { status: 'PASS' },
        observations: {
          title: 'Mock Sangfor HCI Console',
          url: 'http://127.0.0.1:3400/hci',
        },
        evidence: [{
          artifactRef: 'artifact://mock/capture.png',
          sha256: 'a'.repeat(64),
          mediaType: 'image/png',
          size: 8,
        }],
      };
    }),
  };
}

const observerTransport: ObserverTransport = {
  async listPages() { return []; },
  async snapshot() { return { browserPid: 1, browserAlive: true, pages: [] }; },
  async captureStructure() {
    return {
      network: [],
      dom: { elementCount: 0, formCount: 0, iframeCount: 0, shadowHostCount: 0, roleCounts: {} },
      storageMutationCount: 0,
    };
  },
};

beforeAll(async () => {
  const mcp = await import('../apps/mcp-server/src/index.js');
  configureJmBrowserRuntime = (mcp as any).configureJmBrowserRuntime;
  getToolHandler = (mcp as any).getToolHandler;
});

describe('MCP JM browser runtime composition', () => {
  it('routes the existing live read tool through the configured port', async () => {
    const port = fakePort();
    configureJmBrowserRuntime({
      executionPort: port,
      observerTransport,
      async materializeArtifact() {},
    });
    const start = getToolHandler('sangfor_start_operator_session');
    const read = getToolHandler('sangfor_read_live_console_state');
    const kill = getToolHandler('sangfor_kill_session');

    const session = await start?.({
      product: 'HCI',
      mode: 'lab',
      targetUrl: 'http://127.0.0.1:3400/hci',
    }) as { id: string };
    const output = await read?.({ sessionId: session.id }) as Record<string, unknown>;
    await kill?.({ sessionId: session.id });

    expect(output.browser).toBe('jm-local-port');
    expect(port.execute).toHaveBeenCalledWith(expect.objectContaining({
      operation: { kind: 'observe_console', includeSnapshot: true },
    }));
  });

  it('keeps the screenshot tool name while dispatching through the port', async () => {
    const materialized: Array<{ artifactRef: string; destinationPath: string }> = [];
    const sessionOptions: Array<{
      credentials: { username: string; password: string } | undefined;
      headless: unknown;
      targetUrl?: string;
    }> = [];
    const port = fakePort((request) => {
      if (request.operation.kind === 'close_session') return;
      const session = getOperatorSession(request.sessionId);
      sessionOptions.push({
        credentials: session.credentials,
        headless: Reflect.get(session.browser ?? {}, 'headless'),
        targetUrl: session.targetUrl,
      });
    });
    configureJmBrowserRuntime({
      executionPort: port,
      observerTransport,
      async materializeArtifact(artifactRef, destinationPath) {
        materialized.push({ artifactRef, destinationPath });
      },
    });
    const capture = getToolHandler('sangfor_capture_screenshots');

    const output = await capture?.({
      product: 'EPP',
      username: 'qa-admin',
      password: 'qa-secret',
      headless: false,
      menus: [{ menu: 'Dashboard' }],
    }) as { captured: string[]; failed: unknown[] };

    expect(output.failed).toEqual([]);
    expect(output.captured).toEqual([
      expect.stringMatching(/01_Dashboard\.png$/),
    ]);
    expect(materialized).toEqual([{
      artifactRef: 'artifact://mock/capture.png',
      destinationPath: expect.stringMatching(/01_Dashboard\.png$/),
    }]);
    expect(sessionOptions).toEqual([{
      credentials: { username: 'qa-admin', password: 'qa-secret' },
      headless: false,
      targetUrl: 'https://192.0.2.10',
    }]);
    expect(port.execute).toHaveBeenCalledWith(expect.objectContaining({
      operation: { kind: 'close_session' },
    }));
  });

  it('defaults console evidence capture to attach-only CDP port 9222', async () => {
    const observedPorts: Array<number | undefined> = [];
    const port = fakePort((request) => {
      if (request.operation.kind === 'close_session') return;
      observedPorts.push(getOperatorSession(request.sessionId).cdpPort);
    });
    configureJmBrowserRuntime({
      executionPort: port,
      observerTransport,
      async materializeArtifact() {},
    });
    const capture = getToolHandler('sangfor_console_capture_evidence');

    await capture?.({
      product: 'EPP',
      captures: [{
        reqId: '01',
        menuLabel: 'Dashboard',
        url: 'http://127.0.0.1:3400/hci',
      }],
    });

    expect(observedPorts.length).toBeGreaterThan(0);
    expect(observedPorts.every((port) => port === 9222)).toBe(true);
  });
});
