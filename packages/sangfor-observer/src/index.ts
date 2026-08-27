import { randomUUID } from 'node:crypto';
import {
  promoteCapturePayload,
  type CaptureBundleSummary,
} from '@sangfor/collector';
import type {
  AttachObservationRequest,
  CdpBrowserSnapshot,
  ObservationSession,
  ObserverCaptureOptions,
  ObserverProfile,
  ObserverTransport,
  StructuralCapture,
} from './types.js';

export * from './types.js';
export * from './remote-shadow.js';
export { runRemoteShadowCli, type RemoteShadowCliIo } from './remote-shadow-cli.js';

export const OBSERVER_RESERVED_CDP_PORT = 9222;
export const OBSERVER_SESSION_TTL_MS = 10 * 60 * 1_000;

function canonicalOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('ORIGIN_MISMATCH: expectedOrigin must be an absolute URL.');
  }
  if (
    !['http:', 'https:'].includes(url.protocol)
    || url.username
    || url.password
    || url.pathname !== '/'
    || url.search
    || url.hash
  ) {
    throw new Error('ORIGIN_MISMATCH: expectedOrigin must contain only scheme, host, and port.');
  }
  return url.origin;
}

function validatePort(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error('CDP_PORT_INVALID: cdpPort is invalid.');
  }
  if (value === OBSERVER_RESERVED_CDP_PORT) {
    throw new Error('RESERVED_CDP_PORT: port 9222 is reserved.');
  }
  return value;
}

function inObserverProtectionWindow(date: Date): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0) % 24;
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? 0);
  const minutes = hour * 60 + minute;
  return minutes >= 90 && minutes <= 255;
}

function sameSnapshot(before: CdpBrowserSnapshot, after: CdpBrowserSnapshot): boolean {
  if (
    !after.browserAlive
    || before.browserPid !== after.browserPid
    || before.pages.length !== after.pages.length
  ) return false;
  const canonical = (snapshot: CdpBrowserSnapshot) => snapshot.pages
    .map((page) => `${page.id}\0${page.url}`)
    .sort();
  return JSON.stringify(canonical(before)) === JSON.stringify(canonical(after));
}

export class ObserverSessionManager {
  private readonly profiles: ReadonlyMap<number, ObserverProfile>;
  private readonly sessions = new Map<string, ObservationSession>();
  private readonly transport: ObserverTransport;
  private readonly now: () => Date;

  constructor(
    profiles: readonly ObserverProfile[],
    transport?: ObserverTransport,
    now: () => Date = () => new Date(),
  ) {
    if (!transport) {
      throw new Error('OBSERVER_TRANSPORT_REQUIRED: inject transport from the JM runtime.');
    }
    this.transport = transport;
    this.now = now;
    const profileMap = new Map<number, ObserverProfile>();
    for (const profile of profiles) {
      validatePort(profile.cdpPort);
      const expectedOrigin = canonicalOrigin(profile.expectedOrigin);
      if (profileMap.has(profile.cdpPort)) {
        throw new Error('CDP_PORT_OWNERSHIP: duplicate owned port.');
      }
      profileMap.set(profile.cdpPort, Object.freeze({ ...profile, expectedOrigin }));
    }
    this.profiles = profileMap;
  }

  async attach(request: AttachObservationRequest): Promise<ObservationSession> {
    const cdpPort = validatePort(request.cdpPort);
    const current = this.now();
    if (!Number.isFinite(current.getTime())) {
      throw new Error('OBSERVER_CLOCK_INVALID: current time is invalid.');
    }
    if (inObserverProtectionWindow(current)) {
      throw new Error('OBSERVER_PROTECTION_WINDOW: live attach is disabled from 01:30 through 04:15 Asia/Seoul.');
    }
    const profile = this.profiles.get(cdpPort);
    if (!profile) {
      throw new Error('CDP_PORT_OWNERSHIP: port is not owned by the observer profile registry.');
    }
    const expectedOrigin = canonicalOrigin(request.expectedOrigin);
    if (
      profile.product !== request.product
      || profile.expectedOrigin !== expectedOrigin
      || profile.firmwareTruthId !== request.firmwareTruthId
    ) {
      throw new Error('OBSERVER_PROFILE_MISMATCH: product, origin, port, and firmware truth must match exactly.');
    }
    const pages = await this.transport.listPages(cdpPort);
    const exactPages = pages.filter((page) => {
      try {
        return new URL(page.url).origin === expectedOrigin;
      } catch {
        return false;
      }
    });
    if (exactPages.length !== 1) {
      throw new Error('AMBIGUOUS_CDP_PAGE: expected exactly one open page for the selected origin.');
    }
    const before = await this.transport.snapshot(cdpPort);
    if (!before.browserAlive || before.pages.length !== pages.length) {
      throw new Error('CDP_INTEGRITY_ERROR: browser snapshot is inconsistent.');
    }
    const session: ObservationSession = Object.freeze({
      handle: randomUUID(),
      profile,
      target: exactPages[0]!,
      attachedAt: current.toISOString(),
      expiresAt: new Date(current.getTime() + OBSERVER_SESSION_TTL_MS).toISOString(),
      before,
    });
    this.sessions.set(session.handle, session);
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
    if (!session) {
      throw new Error('OBSERVER_SESSION_UNAVAILABLE: handle is missing or expired.');
    }
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
    if (capture.storageMutationCount !== 0) {
      throw new Error('OBSERVER_MUTATION_SIGNAL: DOMStorage changed during capture.');
    }
    if (!sameSnapshot(session.before, after)) {
      throw new Error('OBSERVER_INTEGRITY_ERROR: page count, URLs, PID, or browser liveness changed.');
    }
    return promoteCapturePayload({
      payload: { capture },
      deviceScope: session.profile.deviceScope,
      product: session.profile.product,
      ...(options.firmwareVersion === undefined
        ? {}
        : { firmwareVersion: options.firmwareVersion }),
      capturesDir: options.capturesDir,
      stagingRoot: options.stagingRoot,
      keyring: options.keyring,
    });
  }
}
