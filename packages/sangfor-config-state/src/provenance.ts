// A2 — fact-level provenance envelope (docs/plans/designs/002-device-observability-platform.md).
// Every normalized fact records HOW it was obtained: transport, endpoint/menu path,
// firmware, the mapper version that produced it, measured latency, and the auth
// principal. Construction fails closed: a fact without a complete envelope is a fact
// whose origin cannot be audited, so it must not exist at all.

import {
  ENGINEER_ID_RE,
  type EngineerEnvironmentKind,
} from '../../shared/src/engineer-case-contract.js';

/** Version of the pool→ConfigState mappers in this package. Bump on any mapping
 *  change so stored facts stay attributable to the code that produced them. */
export const MAPPER_VERSION = '1.0.0';

export type FactTransport = 'api' | 'browser';

/** Provenance envelope stamped on every observed fact. This is the collector's
 *  CLAIM about how the value was captured — not a vendor-verified citation. */
export interface FactProvenance {
  transport: FactTransport;
  endpoint: string;
  menuPath?: string[];
  firmwareVersion?: string;
  mapperVersion: string;
  /** Measured round-trip time. Only recorded when actually measured (> 0). */
  latencyMs?: number;
  authPrincipal?: string;
  collectedAt: string;
  /** Retained from the pre-envelope `source` shape: which collector captured it. */
  collector: string;
}

/** Thrown when a fact would be built without a complete, honest provenance envelope. */
export class MissingProvenanceError extends Error {
  override readonly name = 'MissingProvenanceError';
  constructor(reason: string) {
    super(`MISSING_PROVENANCE: ${reason}`);
  }
}

const TRANSPORTS: readonly FactTransport[] = ['api', 'browser'];

function provenanceDefect(input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'provenance envelope is required for every observed fact';
  const p = input as Record<string, unknown>;
  for (const field of ['endpoint', 'mapperVersion', 'collectedAt', 'collector'] as const) {
    if (typeof p[field] !== 'string' || (p[field] as string).length === 0) return `provenance.${field} is required`;
  }
  if (typeof p.transport !== 'string' || !TRANSPORTS.includes(p.transport as FactTransport)) {
    return `provenance.transport must be one of ${TRANSPORTS.join('|')}`;
  }
  if (p.latencyMs !== undefined && (typeof p.latencyMs !== 'number' || !Number.isFinite(p.latencyMs) || p.latencyMs <= 0)) {
    return 'provenance.latencyMs must be omitted or a measured value > 0';
  }
  if (p.menuPath !== undefined && (!Array.isArray(p.menuPath) || p.menuPath.some((s) => typeof s !== 'string' || s.length === 0))) {
    return 'provenance.menuPath must be omitted or a list of non-empty labels';
  }
  for (const field of ['firmwareVersion', 'authPrincipal'] as const) {
    if (p[field] !== undefined && (typeof p[field] !== 'string' || (p[field] as string).length === 0)) {
      return `provenance.${field} must be omitted or a non-empty string`;
    }
  }
  return null;
}

/** Type guard: true only for a complete, well-formed envelope. */
export function isFactProvenance(input: unknown): input is FactProvenance {
  return provenanceDefect(input) === null;
}

/** Throws MissingProvenanceError unless the envelope is complete. */
export function assertFactProvenance(input: unknown): asserts input is FactProvenance {
  const defect = provenanceDefect(input);
  if (defect) throw new MissingProvenanceError(defect);
}

/** Case identity that an observed fact may be bound to. */
export interface CaseFactBinding {
  readonly caseId: string;
  readonly projectId: string;
  readonly observationId: string;
  readonly environmentKind: EngineerEnvironmentKind;
  readonly originalPresent: boolean;
}

export type BoundCaseFact =
  | {
      readonly ok: true;
      readonly sourceKind: 'observed';
      readonly caseId: string;
      readonly projectId: string;
      readonly observationId: string;
      readonly provenance: FactProvenance;
    }
  | { readonly ok: false; readonly reason: string };

function bindingIdDefect(value: string, label: string): string | null {
  if (!ENGINEER_ID_RE.test(value) || value === '.' || value === '..' || value.includes('..')) {
    return `INVALID_ID:${label}`;
  }
  return null;
}

/**
 * Reuse a complete FactProvenance envelope as an engineer-case observation
 * source. Fixture/historical snapshots and missing originals cannot become
 * live observed values.
 */
export function bindObservedFactToCase(fact: unknown, binding: CaseFactBinding): BoundCaseFact {
  const defect = provenanceDefect(fact);
  if (defect) return { ok: false, reason: `INVALID_PROVENANCE:${defect}` };
  for (const [label, value] of [
    ['caseId', binding.caseId],
    ['projectId', binding.projectId],
    ['observationId', binding.observationId],
  ] as const) {
    const idDefect = bindingIdDefect(value, label);
    if (idDefect) return { ok: false, reason: idDefect };
  }
  if (binding.environmentKind !== 'live') return { ok: false, reason: 'FIXTURE_MARKED_OBSERVED' };
  if (binding.originalPresent !== true) return { ok: false, reason: 'MISSING_ORIGINAL_MARKED_OBSERVED' };
  return {
    ok: true,
    sourceKind: 'observed',
    caseId: binding.caseId,
    projectId: binding.projectId,
    observationId: binding.observationId,
    provenance: fact as FactProvenance,
  };
}
