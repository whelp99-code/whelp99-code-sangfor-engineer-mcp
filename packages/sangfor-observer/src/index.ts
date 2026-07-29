import { randomUUID } from 'node:crypto';
import {
  promoteCapturePayload,
  type CaptureBundleSummary,
  type CaptureKeyring,
} from '@sangfor/collector';

export const OBSERVER_RESERVED_CDP_PORT = 9222;
export const OBSERVER_SESSION_TTL_MS = 10 * 60 * 1_000;

export interface ObserverProfile {
  product: string;
  expectedOrigin: string;
  cdpPort: number;
  firmwareTruthId: string;
  deviceScope: string;
}

export interface AttachObservationRequest {
  product: string;
  expectedOrigin: string;
  cdpPort: number;
  firmwareTruthId: string;
}

export interface CdpPageTarget {
  id: string;
  url: string;
  webSocketDebuggerUrl: string;
}

export interface CdpBrowserSnapshot {
  browserPid: number;
  browserAlive: boolean;
  pages: Array<{ id: string; url: string }>;
}

export interface StructuralCapture {
  network: Array<{ method: string; origin: string; path: string; resourceType: string; status?: number }>;
  dom: {
    elementCount: number;
    formCount: number;
    iframeCount: number;
    shadowHostCount: number;
    roleCounts: Record<string, number>;
  };
  storageMutationCount: number;
}

export interface ObserverTransport {
  listPages(cdpPort: number): Promise<CdpPageTarget[]>;
  snapshot(cdpPort: number): Promise<CdpBrowserSnapshot>;
  captureStructure(target: CdpPageTarget, durationMs: number): Promise<StructuralCapture>;
}

export interface ObservationSession {
  handle: string;
  profile: ObserverProfile;
  target: CdpPageTarget;
  attachedAt: string;
  expiresAt: string;
  before: CdpBrowserSnapshot;
}

export interface ObserverCaptureOptions {
  sessionHandle: string;
  durationMs?: number;
  capturesDir: string;
  stagingRoot: string;
  keyring: CaptureKeyring;
  firmwareVersion?: string;
}

function canonicalOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('ORIGIN_MISMATCH: expectedOrigin must be an absolute URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('ORIGIN_MISMATCH: expectedOrigin must contain only scheme, host, and port.');
  }
  return url.origin;
}

function validatePort(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) throw new Error('CDP_PORT_INVALID: cdpPort is invalid.');
  if (value === OBSERVER_RESERVED_CDP_PORT) throw new Error('RESERVED_CDP_PORT: port 9222 is reserved.');
  return value;
}

function seoulMinutes(date: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul', hour12: false, hour: '2-digit', minute: '2-digit',
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0) % 24;
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? 0);
  return hour * 60 + minute;
}

function inObserverProtectionWindow(date: Date): boolean {
  const minutes = seoulMinutes(date);
  return minutes >= 90 && minutes <= 255;
}

function sameSnapshot(before: CdpBrowserSnapshot, after: CdpBrowserSnapshot): boolean {
  if (!after.browserAlive || before.browserPid !== after.browserPid || before.pages.length !== after.pages.length) return false;
  const canonical = (snapshot: CdpBrowserSnapshot) => snapshot.pages
    .map((page) => `${page.id}\0${page.url}`)
    .sort();
  return JSON.stringify(canonical(before)) === JSON.stringify(canonical(after));
}

export class ObserverSessionManager {
  private readonly profiles: ReadonlyMap<number, ObserverProfile>;
  private readonly sessions = new Map<string, ObservationSession>();

  constructor(
    profiles: readonly ObserverProfile[],
    private readonly transport: ObserverTransport = new HttpCdpObserverTransport(),
    private readonly now: () => Date = () => new Date(),
  ) {
    const profileMap = new Map<number, ObserverProfile>();
    for (const profile of profiles) {
      validatePort(profile.cdpPort);
      const expectedOrigin = canonicalOrigin(profile.expectedOrigin);
      if (profileMap.has(profile.cdpPort)) throw new Error('CDP_PORT_OWNERSHIP: duplicate owned port.');
      profileMap.set(profile.cdpPort, Object.freeze({ ...profile, expectedOrigin }));
    }
    this.profiles = profileMap;
  }

  async attach(request: AttachObservationRequest): Promise<ObservationSession> {
    const cdpPort = validatePort(request.cdpPort);
    const current = this.now();
    if (!Number.isFinite(current.getTime())) throw new Error('OBSERVER_CLOCK_INVALID: current time is invalid.');
    if (inObserverProtectionWindow(current)) throw new Error('OBSERVER_PROTECTION_WINDOW: live attach is disabled from 01:30 through 04:15 Asia/Seoul.');
    const profile = this.profiles.get(cdpPort);
    if (!profile) throw new Error('CDP_PORT_OWNERSHIP: port is not owned by the observer profile registry.');
    const expectedOrigin = canonicalOrigin(request.expectedOrigin);
    if (profile.product !== request.product || profile.expectedOrigin !== expectedOrigin
      || profile.firmwareTruthId !== request.firmwareTruthId) {
      throw new Error('OBSERVER_PROFILE_MISMATCH: product, origin, port, and firmware truth must match exactly.');
    }
    const pages = await this.transport.listPages(cdpPort);
    const exactPages = pages.filter((page) => {
      try { return new URL(page.url).origin === expectedOrigin; } catch { return false; }
    });
    if (exactPages.length !== 1) throw new Error('AMBIGUOUS_CDP_PAGE: expected exactly one open page for the selected origin.');
    const before = await this.transport.snapshot(cdpPort);
    if (!before.browserAlive || before.pages.length !== pages.length) throw new Error('CDP_INTEGRITY_ERROR: browser snapshot is inconsistent.');
    const handle = randomUUID();
    const session: ObservationSession = Object.freeze({
      handle,
      profile,
      target: exactPages[0]!,
      attachedAt: current.toISOString(),
      expiresAt: new Date(current.getTime() + OBSERVER_SESSION_TTL_MS).toISOString(),
      before,
    });
    this.sessions.set(handle, session);
    return session;
  }

  get(handle: string): ObservationSession | null {
    const session = this.sessions.get(handle);
    if (!session) return null;
    if (this.now().getTime() > Date.parse(session.expiresAt)) {
      this.sessions.delete(handle);
      return null;
    }
    return session;
  }

  detach(handle: string): void {
    this.sessions.delete(handle);
  }

  async capture(options: ObserverCaptureOptions): Promise<CaptureBundleSummary> {
    const session = this.get(options.sessionHandle);
    if (!session) throw new Error('OBSERVER_SESSION_UNAVAILABLE: handle is missing or expired.');
    const durationMs = options.durationMs ?? 250;
    if (!Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > 30_000) {
      throw new Error('OBSERVER_CAPTURE_INVALID: duration must be between 0 and 30000ms.');
    }
    let capture: StructuralCapture;
    try {
      capture = await this.transport.captureStructure(session.target, durationMs);
    } finally {
      this.sessions.delete(session.handle);
    }
    const after = await this.transport.snapshot(session.profile.cdpPort);
    if (capture.storageMutationCount !== 0) throw new Error('OBSERVER_MUTATION_SIGNAL: DOMStorage changed during capture.');
    if (!sameSnapshot(session.before, after)) throw new Error('OBSERVER_INTEGRITY_ERROR: page count, URLs, PID, or browser liveness changed.');
    return promoteCapturePayload({
      payload: { capture },
      deviceScope: session.profile.deviceScope,
      product: session.profile.product,
      ...(options.firmwareVersion === undefined ? {} : { firmwareVersion: options.firmwareVersion }),
      capturesDir: options.capturesDir,
      stagingRoot: options.stagingRoot,
      keyring: options.keyring,
    });
  }
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string };
}

class CdpSocket {
  private id = 0;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly listeners = new Set<(message: CdpMessage) => void>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as CdpMessage;
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message ?? 'CDP command failed.'));
        else pending.resolve(message.result);
      } else {
        for (const listener of this.listeners) listener(message);
      }
    });
  }

  static async connect(url: string): Promise<CdpSocket> {
    if (!/^ws:\/\/(?:127\.0\.0\.1|localhost):\d+\//u.test(url)) throw new Error('REMOTE_CDP_REFUSED: CDP websocket must be loopback.');
    const socket = new WebSocket(url);
    await new Promise<void>((resolvePromise, reject) => {
      socket.addEventListener('open', () => resolvePromise(), { once: true });
      socket.addEventListener('error', () => reject(new Error('CDP_TRANSPORT_UNAVAILABLE: websocket connection failed.')), { once: true });
    });
    return new CdpSocket(socket);
  }

  onEvent(listener: (message: CdpMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.id;
    const result = new Promise<unknown>((resolvePromise, reject) => this.pending.set(id, { resolve: resolvePromise, reject }));
    this.socket.send(JSON.stringify({ id, method, params }));
    return await result as T;
  }

  close(): void {
    this.socket.close();
    for (const pending of this.pending.values()) pending.reject(new Error('CDP_TRANSPORT_CLOSED: socket closed.'));
    this.pending.clear();
  }
}

async function fetchLoopbackJson<T>(port: number, path: string): Promise<T> {
  validatePort(port);
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  if (!response.ok) throw new Error(`CDP_TRANSPORT_UNAVAILABLE: ${path} returned ${response.status}.`);
  return await response.json() as T;
}

export class HttpCdpObserverTransport implements ObserverTransport {
  async listPages(cdpPort: number): Promise<CdpPageTarget[]> {
    const targets = await fetchLoopbackJson<Array<Record<string, unknown>>>(cdpPort, '/json/list');
    return targets
      .filter((target) => target.type === 'page' && typeof target.id === 'string'
        && typeof target.url === 'string' && typeof target.webSocketDebuggerUrl === 'string')
      .map((target) => ({ id: target.id as string, url: target.url as string, webSocketDebuggerUrl: target.webSocketDebuggerUrl as string }));
  }

  async snapshot(cdpPort: number): Promise<CdpBrowserSnapshot> {
    const [version, pages] = await Promise.all([
      fetchLoopbackJson<Record<string, unknown>>(cdpPort, '/json/version'),
      this.listPages(cdpPort),
    ]);
    const browserWs = version.webSocketDebuggerUrl;
    if (typeof browserWs !== 'string') throw new Error('CDP_INTEGRITY_ERROR: browser websocket is absent.');
    const socket = await CdpSocket.connect(browserWs);
    try {
      const processInfo = await socket.send<{ processInfo?: Array<{ type?: string; id?: number }> }>('SystemInfo.getProcessInfo');
      const browser = processInfo.processInfo?.find((process) => process.type === 'browser');
      if (!browser || !Number.isSafeInteger(browser.id)) throw new Error('CDP_INTEGRITY_ERROR: browser PID is unavailable.');
      return { browserPid: browser.id!, browserAlive: true, pages: pages.map(({ id, url }) => ({ id, url })) };
    } finally {
      socket.close();
    }
  }

  async captureStructure(target: CdpPageTarget, durationMs: number): Promise<StructuralCapture> {
    const socket = await CdpSocket.connect(target.webSocketDebuggerUrl);
    const network: StructuralCapture['network'] = [];
    let storageMutationCount = 0;
    const off = socket.onEvent((message) => {
      if (message.method?.startsWith('DOMStorage.domStorage')) storageMutationCount += 1;
      if (message.method === 'Network.responseReceived') {
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
        } catch { /* discard malformed URL */ }
      }
    });
    try {
      await socket.send('DOMStorage.enable');
      await socket.send('Network.enable', { maxTotalBufferSize: 0, maxResourceBufferSize: 0, maxPostDataSize: 0 });
      const evaluated = await socket.send<{ result?: { value?: unknown } }>('Runtime.evaluate', {
        expression: `(() => {
          const roleCounts = {};
          for (const element of document.querySelectorAll('[role]')) {
            const role = element.getAttribute('role');
            if (role && /^[a-z-]{1,32}$/.test(role)) roleCounts[role] = (roleCounts[role] || 0) + 1;
          }
          let shadowHostCount = 0;
          for (const element of document.querySelectorAll('*')) if (element.shadowRoot) shadowHostCount += 1;
          return {
            elementCount: document.querySelectorAll('*').length,
            formCount: document.forms.length,
            iframeCount: document.querySelectorAll('iframe').length,
            shadowHostCount,
            roleCounts,
          };
        })()`,
        returnByValue: true,
      });
      await new Promise((resolvePromise) => setTimeout(resolvePromise, durationMs));
      const dom = evaluated.result?.value;
      if (!dom || typeof dom !== 'object' || Array.isArray(dom)) throw new Error('OBSERVER_CAPTURE_INVALID: structural DOM result is invalid.');
      return { network: network.slice(0, 10_000), dom: dom as StructuralCapture['dom'], storageMutationCount };
    } finally {
      off();
      socket.close();
    }
  }
}
