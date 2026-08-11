import type {
  CdpBrowserSnapshot,
  CdpPageTarget,
  ObserverTransport,
  StructuralCapture,
} from '../../sangfor-observer/src/index.js';

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string };
}

class CdpSocket {
  private id = 0;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private readonly listeners = new Set<(message: CdpMessage) => void>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as CdpMessage;
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message ?? 'CDP command failed.'));
        } else {
          pending.resolve(message.result);
        }
        return;
      }
      for (const listener of this.listeners) listener(message);
    });
  }

  static async connect(url: string): Promise<CdpSocket> {
    if (!/^ws:\/\/(?:127\.0\.0\.1|localhost):\d+\//u.test(url)) {
      throw new Error('REMOTE_CDP_REFUSED: CDP websocket must be loopback.');
    }
    const socket = new WebSocket(url);
    await new Promise<void>((resolvePromise, reject) => {
      socket.addEventListener('open', () => resolvePromise(), { once: true });
      socket.addEventListener(
        'error',
        () => reject(new Error('CDP_TRANSPORT_UNAVAILABLE: websocket connection failed.')),
        { once: true },
      );
    });
    return new CdpSocket(socket);
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.id;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  onEvent(listener: (message: CdpMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.socket.close();
    for (const pending of this.pending.values()) {
      pending.reject(new Error('CDP_TRANSPORT_CLOSED: connection closed.'));
    }
    this.pending.clear();
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const parsed = new URL(url);
  if (!['127.0.0.1', 'localhost'].includes(parsed.hostname)) {
    throw new Error('REMOTE_CDP_REFUSED: CDP HTTP endpoint must be loopback.');
  }
  const response = await fetch(parsed);
  if (!response.ok) {
    throw new Error(`CDP_TRANSPORT_UNAVAILABLE: ${response.status}.`);
  }
  return response.json();
}

function pageTarget(value: unknown): CdpPageTarget | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (
    item.type !== 'page'
    || typeof item.id !== 'string'
    || typeof item.url !== 'string'
    || typeof item.webSocketDebuggerUrl !== 'string'
  ) return undefined;
  return {
    id: item.id,
    url: item.url,
    webSocketDebuggerUrl: item.webSocketDebuggerUrl,
  };
}

export class HttpCdpObserverTransport implements ObserverTransport {
  async listPages(cdpPort: number): Promise<CdpPageTarget[]> {
    const raw = await fetchJson(`http://127.0.0.1:${cdpPort}/json/list`);
    if (!Array.isArray(raw)) {
      throw new Error('CDP_TRANSPORT_INVALID: /json/list must return an array.');
    }
    return raw.map(pageTarget).filter((target): target is CdpPageTarget => target !== undefined);
  }

  async snapshot(cdpPort: number): Promise<CdpBrowserSnapshot> {
    const pages = await this.listPages(cdpPort);
    const version = await fetchJson(`http://127.0.0.1:${cdpPort}/json/version`);
    const browserUrl = version && typeof version === 'object' && !Array.isArray(version)
      ? (version as Record<string, unknown>).webSocketDebuggerUrl
      : undefined;
    if (typeof browserUrl !== 'string') {
      throw new Error('CDP_TRANSPORT_INVALID: browser websocket URL is missing.');
    }
    const socket = await CdpSocket.connect(browserUrl);
    try {
      const processInfo = await socket.send<{
        processInfo?: Array<{ type?: string; id?: number }>;
      }>('SystemInfo.getProcessInfo');
      const browserPid = processInfo.processInfo?.find((item) => item.type === 'browser')?.id;
      if (!Number.isSafeInteger(browserPid)) {
        throw new Error('CDP_TRANSPORT_INVALID: browser PID is unavailable.');
      }
      return {
        browserPid: browserPid!,
        browserAlive: true,
        pages: pages.map(({ id, url }) => ({ id, url })),
      };
    } finally {
      socket.close();
    }
  }

  async captureStructure(
    target: CdpPageTarget,
    durationMs: number,
  ): Promise<StructuralCapture> {
    const socket = await CdpSocket.connect(target.webSocketDebuggerUrl);
    const network: StructuralCapture['network'] = [];
    let storageMutationCount = 0;
    const off = socket.onEvent((message) => {
      if (message.method?.startsWith('DOMStorage.domStorage')) storageMutationCount += 1;
      if (message.method !== 'Network.responseReceived') return;
      const params = message.params ?? {};
      const response = params.response as Record<string, unknown> | undefined;
      if (!response || typeof response.url !== 'string') return;
      try {
        const url = new URL(response.url);
        if (!['http:', 'https:'].includes(url.protocol)) return;
        network.push({
          method: 'RESPONSE',
          origin: url.origin,
          path: url.pathname,
          resourceType: typeof params.type === 'string' ? params.type : 'Other',
          ...(typeof response.status === 'number' ? { status: response.status } : {}),
        });
      } catch {
        return;
      }
    });
    try {
      await socket.send('DOMStorage.enable');
      await socket.send('Network.enable', {
        maxTotalBufferSize: 0,
        maxResourceBufferSize: 0,
        maxPostDataSize: 0,
      });
      const evaluated = await socket.send<{ result?: { value?: unknown } }>(
        'Runtime.evaluate',
        {
          expression: `(() => {
            const roleCounts = {};
            for (const element of document.querySelectorAll('[role]')) {
              const role = element.getAttribute('role');
              if (role && /^[a-z-]{1,32}$/.test(role)) {
                roleCounts[role] = (roleCounts[role] || 0) + 1;
              }
            }
            let shadowHostCount = 0;
            for (const element of document.querySelectorAll('*')) {
              if (element.shadowRoot) shadowHostCount += 1;
            }
            return {
              elementCount: document.querySelectorAll('*').length,
              formCount: document.forms.length,
              iframeCount: document.querySelectorAll('iframe').length,
              shadowHostCount,
              roleCounts,
            };
          })()`,
          returnByValue: true,
        },
      );
      await new Promise((resolvePromise) => setTimeout(resolvePromise, durationMs));
      const dom = evaluated.result?.value;
      if (!dom || typeof dom !== 'object' || Array.isArray(dom)) {
        throw new Error('OBSERVER_CAPTURE_INVALID: structural DOM result is invalid.');
      }
      return {
        network: network.slice(0, 10_000),
        dom: dom as StructuralCapture['dom'],
        storageMutationCount,
      };
    } finally {
      off();
      socket.close();
    }
  }
}

export function createJmObserverTransport(): ObserverTransport {
  return new HttpCdpObserverTransport();
}
