/**
 * Map an in-process HCI collect onto E12 bound-observation inputs.
 *
 * `authorized_device_read` is still minted only by
 * `bindEngineerAuthorizedDeviceReadEvidence` after every required surface
 * binds. This module does not invent E03B / firmware / collectedAt bytes,
 * does not treat mock :3400 as live, and does not flip `field_accepted`.
 */

import { canonicalizeUrlOrigin } from '../../shared/src/origin.js';
import {
  type EngineerBoundObservationInput,
  type EngineerRequiredLiveReadSurfaceId,
} from '../../shared/src/engineer-field-acceptance.js';
import {
  bindEngineerAuthorizedDeviceReadEvidence,
  type EngineerAuthorizedDeviceReadBindResult,
} from './engineer-field-acceptance-bind.js';
import type { HciCollectionSnapshotInventory, HciCollectionSnapshotSurface } from './hci-collection-snapshot.js';

/** Must match `@sangfor/hci-client` `HCI_COLLECTOR`. Imported as a string so L1 packages do not import sideways. */
const HCI_REST_COLLECTOR = 'hci-rest-collector';

const REST_SURFACES = ['volumes', 'servers', 'images'] as const satisfies readonly HciCollectionSnapshotSurface[];

const REST_ENDPOINTS: Record<HciCollectionSnapshotSurface, string> = {
  volumes: 'GET /volumes/detail',
  servers: 'GET /servers',
  images: 'GET /v2/images',
};

export type AuthorizedDeviceCollectSession = {
  readonly kind: 'authorized_device_collect';
  readonly declaredTarget: string;
  readonly measuredIdentityOrigin: string;
  readonly collectExecuted: true;
};

/** Caller session before kind/origin checks. Historical / fixture / mock kinds refuse. */
export type CollectBindSessionInput = {
  readonly kind: string;
  readonly declaredTarget: string;
  readonly measuredIdentityOrigin: string;
  readonly collectExecuted?: boolean;
};

export type BindHciCollectObservationsResult =
  | {
      readonly ok: true;
      readonly originalPresent: true;
      readonly observations: readonly EngineerBoundObservationInput[];
    }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly originalPresent: false;
      readonly observations: readonly [];
    };

function hostOf(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(trimmed)) return new URL(trimmed).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (/[/?#]/.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

function parseOriginish(value: string): { hostname: string; port: string } | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(trimmed) ? trimmed : `https://${trimmed}`);
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    return { hostname: url.hostname.toLowerCase(), port };
  } catch {
    return null;
  }
}

export function isMockConsoleOrigin(value: string): boolean {
  const parsed = parseOriginish(value);
  if (!parsed) return false;
  const loopback = parsed.hostname === 'localhost'
    || parsed.hostname === '127.0.0.1'
    || parsed.hostname === '::1'
    || parsed.hostname === '[::1]';
  return loopback && parsed.port === '3400';
}

export function authorizedCollectTargetsMatch(declared: string, measured: string): boolean {
  const declaredIsUrl = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(declared.trim());
  const measuredIsUrl = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(measured.trim());
  if (declaredIsUrl && measuredIsUrl) {
    try {
      return canonicalizeUrlOrigin(declared, 'url') === canonicalizeUrlOrigin(measured, 'url');
    } catch {
      return false;
    }
  }
  const declaredHost = hostOf(declared);
  const measuredHost = hostOf(measured);
  return Boolean(declaredHost && measuredHost && declaredHost === measuredHost);
}

function surfaceBindable(
  inventory: HciCollectionSnapshotInventory,
  surface: HciCollectionSnapshotSurface,
): boolean {
  const status = inventory.collection[surface]?.status;
  if (status !== 'complete' && status !== 'partial') return false;
  const provenance = inventory.provenance[surface];
  if (!provenance || typeof provenance !== 'object') return false;
  if (provenance.collector !== HCI_REST_COLLECTOR) return false;
  if (provenance.endpoint !== REST_ENDPOINTS[surface]) return false;
  if (provenance.transport !== 'api') return false;
  return Array.isArray(inventory[surface]);
}

function sessionDefect(session: CollectBindSessionInput, inventory: HciCollectionSnapshotInventory): string | undefined {
  if (session.kind === 'historical_record' || session.kind === 'historical') {
    return 'HISTORICAL_RECORD_IS_NOT_CURRENT_LIVE';
  }
  if (session.kind === 'fixture' || session.kind === 'attestation') {
    return 'FIXTURE_COLLECT_IS_NOT_AUTHORIZED_DEVICE';
  }
  if (session.kind === 'mock_console') return 'MOCK_CONSOLE_IS_NOT_FIELD_ACCEPTED';
  if (session.kind !== 'authorized_device_collect') return 'FIXTURE_COLLECT_IS_NOT_AUTHORIZED_DEVICE';
  if (session.collectExecuted !== true) return 'COLLECT_NOT_EXECUTED';
  if (!session.declaredTarget.trim() || !session.measuredIdentityOrigin.trim()) return 'TARGET_UNVERIFIED';
  if (isMockConsoleOrigin(session.declaredTarget) || isMockConsoleOrigin(session.measuredIdentityOrigin)) {
    return 'MOCK_CONSOLE_IS_NOT_FIELD_ACCEPTED';
  }
  if (!authorizedCollectTargetsMatch(session.declaredTarget, session.measuredIdentityOrigin)) {
    return 'TARGET_MISMATCH';
  }
  const requestTarget = inventory.request?.target;
  if (typeof requestTarget !== 'string' || requestTarget.trim().length === 0) {
    return 'TARGET_UNVERIFIED';
  }
  if (!authorizedCollectTargetsMatch(requestTarget, session.declaredTarget)) {
    return 'TARGET_MISMATCH';
  }
  return undefined;
}

/**
 * Emit grant-usable bound inputs from this collect only.
 * Unsupported E03B / firmware / collectedAt surfaces stay omitted (NOT_RUN later).
 */
export function bindHciCollectToFieldAcceptanceObservations(input: {
  readonly inventory: HciCollectionSnapshotInventory;
  readonly caseId: string;
  readonly projectId: string;
  readonly session: CollectBindSessionInput;
}): BindHciCollectObservationsResult {
  const defect = sessionDefect(input.session, input.inventory);
  if (defect) {
    return { ok: false, reason: defect, originalPresent: false, observations: [] };
  }

  const observations: EngineerBoundObservationInput[] = [];
  for (const surface of REST_SURFACES) {
    if (!surfaceBindable(input.inventory, surface)) continue;
    observations.push({
      surfaceId: surface as EngineerRequiredLiveReadSurfaceId,
      fact: input.inventory.provenance[surface],
      caseId: input.caseId,
      projectId: input.projectId,
      observationId: `obs-${surface}`,
      environmentKind: 'live',
      originalPresent: true,
      payload: {
        surfaceId: surface,
        collectionRevision: input.inventory.collectionRevision,
        collectedAt: input.inventory.collectedAt,
        status: input.inventory.collection[surface].status,
        items: input.inventory[surface],
      },
    });
  }

  if (observations.length === 0) {
    return {
      ok: false,
      reason: 'NO_ORIGINAL_PRESENT_SURFACE',
      originalPresent: false,
      observations: [],
    };
  }

  return { ok: true, originalPresent: true, observations };
}

export function bindHciCollectAuthorizedDeviceReadEvidence(input: {
  readonly inventory: HciCollectionSnapshotInventory;
  readonly caseId: string;
  readonly projectId: string;
  readonly caseRevision: string;
  readonly guideRevision: string;
  readonly session: CollectBindSessionInput;
}): {
  readonly collect: BindHciCollectObservationsResult;
  readonly authorized: EngineerAuthorizedDeviceReadBindResult;
} {
  const collect = bindHciCollectToFieldAcceptanceObservations(input);
  const authorized = bindEngineerAuthorizedDeviceReadEvidence({
    caseRevision: input.caseRevision,
    guideRevision: input.guideRevision,
    observations: collect.ok ? collect.observations : [],
  });
  return { collect, authorized };
}
