/**
 * Re-bind E12 grant evidence through `bindObservedFactToCase`.
 *
 * `sourceKind: authorized_device_read` is derived only after every required
 * surface binds with live + originalPresent. Fixture/synthetic constructors
 * cannot mint that source by setting labels. This is not a live HCI collect
 * and does not invent device bytes.
 */

import { createHash } from 'node:crypto';
import {
  ENGINEER_REQUIRED_LIVE_READ_SURFACES,
  type EngineerBoundObservationInput,
  type EngineerLiveReadEvidence,
  type EngineerLiveReadSurfaceStatus,
  type EngineerRequiredLiveReadSurfaceId,
} from '../../shared/src/engineer-field-acceptance.js';
import { bindObservedFactToCase, type FactProvenance } from './provenance.js';

export type ReboundFieldAcceptanceObservation = {
  readonly surfaceId: EngineerRequiredLiveReadSurfaceId;
  readonly caseId: string;
  readonly projectId: string;
  readonly observationId: string;
  readonly sourceKind: 'observed';
  readonly provenance: FactProvenance;
  readonly payload: unknown;
};

export type EngineerAuthorizedDeviceReadBindResult =
  | {
      readonly ok: true;
      readonly sourceKind: 'authorized_device_read';
      readonly observationDigest: string;
      readonly bound: readonly ReboundFieldAcceptanceObservation[];
      readonly liveRead: EngineerLiveReadEvidence;
      readonly requiredLiveSurfaces: readonly EngineerLiveReadSurfaceStatus[];
    }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly bound: readonly ReboundFieldAcceptanceObservation[];
      readonly requiredLiveSurfaces: readonly EngineerLiveReadSurfaceStatus[];
    };

function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as object)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export function rebindEngineerFieldAcceptanceObservations(
  inputs: readonly EngineerBoundObservationInput[] = [],
): {
  readonly bound: ReboundFieldAcceptanceObservation[];
  readonly failed: readonly { readonly surfaceId: EngineerRequiredLiveReadSurfaceId; readonly reason: string }[];
} {
  const bound: ReboundFieldAcceptanceObservation[] = [];
  const failed: { readonly surfaceId: EngineerRequiredLiveReadSurfaceId; readonly reason: string }[] = [];
  const seen = new Set<EngineerRequiredLiveReadSurfaceId>();

  for (const input of inputs) {
    if (seen.has(input.surfaceId)) {
      failed.push({ surfaceId: input.surfaceId, reason: 'DUPLICATE_BOUND_SURFACE' });
      continue;
    }
    seen.add(input.surfaceId);
    const rebound = bindObservedFactToCase(input.fact, {
      caseId: input.caseId,
      projectId: input.projectId,
      observationId: input.observationId,
      environmentKind: input.environmentKind,
      originalPresent: input.originalPresent,
    });
    if (!rebound.ok) {
      failed.push({ surfaceId: input.surfaceId, reason: rebound.reason });
      continue;
    }
    bound.push({
      surfaceId: input.surfaceId,
      caseId: rebound.caseId,
      projectId: rebound.projectId,
      observationId: rebound.observationId,
      sourceKind: 'observed',
      provenance: rebound.provenance,
      payload: input.payload,
    });
  }

  return { bound, failed };
}

export function digestEngineerBoundObservations(
  bound: readonly ReboundFieldAcceptanceObservation[],
): string {
  const rows = [...bound]
    .sort((left, right) => left.surfaceId.localeCompare(right.surfaceId))
    .map((item) => ({
      surfaceId: item.surfaceId,
      caseId: item.caseId,
      projectId: item.projectId,
      observationId: item.observationId,
      sourceKind: item.sourceKind,
      provenance: item.provenance,
      payload: item.payload,
    }));
  return createHash('sha256').update(stableJson(rows), 'utf8').digest('hex');
}

export function surfacesFromBoundObservations(
  bound: readonly ReboundFieldAcceptanceObservation[],
): EngineerLiveReadSurfaceStatus[] {
  const present = new Set(bound.map((item) => item.surfaceId));
  return ENGINEER_REQUIRED_LIVE_READ_SURFACES.map((surface) => ({
    id: surface.id,
    layer: surface.layer,
    acquisition: surface.acquisition,
    status: present.has(surface.id) ? 'BOUND_ORIGINAL_PRESENT' : 'NOT_RUN',
  }));
}

export function requiredSurfacesMissingBoundFacts(
  bound: readonly ReboundFieldAcceptanceObservation[],
): EngineerRequiredLiveReadSurfaceId[] {
  const present = new Set(bound.map((item) => item.surfaceId));
  return ENGINEER_REQUIRED_LIVE_READ_SURFACES
    .map((surface) => surface.id)
    .filter((id) => !present.has(id));
}

/**
 * The only constructor that may emit `authorized_device_read`.
 * Requires a successful live+originalPresent bind for every required surface.
 */
export function bindEngineerAuthorizedDeviceReadEvidence(input: {
  readonly caseRevision: string;
  readonly guideRevision: string;
  readonly observations: readonly EngineerBoundObservationInput[];
}): EngineerAuthorizedDeviceReadBindResult {
  const { bound, failed } = rebindEngineerFieldAcceptanceObservations(input.observations);
  const requiredLiveSurfaces = surfacesFromBoundObservations(bound);
  const missing = requiredSurfacesMissingBoundFacts(bound);
  if (failed.length > 0) {
    return {
      ok: false,
      reason: failed[0]?.reason ?? 'LIVE_BOUND_FACTS_REQUIRED',
      bound,
      requiredLiveSurfaces,
    };
  }
  if (missing.length > 0 || bound.length !== ENGINEER_REQUIRED_LIVE_READ_SURFACES.length) {
    return {
      ok: false,
      reason: 'REQUIRED_LIVE_SURFACES_NOT_RUN',
      bound,
      requiredLiveSurfaces,
    };
  }
  if (bound.some((item) => item.sourceKind !== 'observed')) {
    return {
      ok: false,
      reason: 'LIVE_READ_SOURCE_NOT_AUTHORIZED_DEVICE',
      bound,
      requiredLiveSurfaces,
    };
  }
  const observationDigest = digestEngineerBoundObservations(bound);
  return {
    ok: true,
    sourceKind: 'authorized_device_read',
    observationDigest,
    bound,
    requiredLiveSurfaces,
    liveRead: {
      executed: true,
      environmentKind: 'live',
      originalPresent: true,
      synthetic: false,
      sourceKind: 'authorized_device_read',
      caseRevision: input.caseRevision,
      guideRevision: input.guideRevision,
    },
  };
}
