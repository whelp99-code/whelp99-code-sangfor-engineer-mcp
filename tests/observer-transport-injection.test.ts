import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJmObserverTransport } from '../packages/sangfor-jm-execution/src/index.js';
import {
  ObserverSessionManager,
  type ObserverProfile,
} from '../packages/sangfor-observer/src/index.js';

const profile: ObserverProfile = {
  product: 'ENDPOINT_SECURE',
  expectedOrigin: 'https://10.80.1.106',
  cdpPort: 9333,
  firmwareTruthId: 'epp-6.0.4',
  deviceScope: 'lab-device',
};

describe('observer transport composition', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requires transport injection instead of constructing CDP inside policy', () => {
    expect(() => new ObserverSessionManager([profile]))
      .toThrow(/OBSERVER_TRANSPORT_REQUIRED/);
  });

  it('creates the default loopback transport from the JM runtime package', () => {
    const transport = createJmObserverTransport();

    expect(transport).toMatchObject({
      listPages: expect.any(Function),
      snapshot: expect.any(Function),
      captureStructure: expect.any(Function),
    });
  });

  it('lists only CDP targets whose type is page', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([
      {
        id: 'page-1',
        type: 'page',
        url: 'https://10.80.1.106/',
        webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/page-1',
      },
      {
        id: 'worker-1',
        type: 'service_worker',
        url: 'https://10.80.1.106/sw.js',
        webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/worker-1',
      },
    ]))));
    const transport = createJmObserverTransport();

    const pages = await transport.listPages(9333);

    expect(pages.map((page) => page.id)).toEqual(['page-1']);
  });
});
