import type { CaptureKeyring } from '@sangfor/collector';

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
  network: Array<{
    method: string;
    origin: string;
    path: string;
    resourceType: string;
    status?: number;
  }>;
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
  captureStructure(
    target: CdpPageTarget,
    durationMs: number,
  ): Promise<StructuralCapture>;
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
