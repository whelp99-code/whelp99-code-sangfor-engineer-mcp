// A2 — fact-level provenance envelope (docs/plans/designs/002-device-observability-platform.md).
// Every normalized fact records HOW it was obtained: transport, endpoint/menu path,
// firmware, the mapper version that produced it, measured latency, and the auth
// principal. Construction fails closed: a fact without a complete envelope is a fact
// whose origin cannot be audited, so it must not exist at all.

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
