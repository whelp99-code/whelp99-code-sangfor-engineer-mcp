// A2 (Step 2) — fact-level provenance for the HCI/SCP REST *collection* path.
// Structurally compatible with @sangfor/config-state's FactProvenance, declared
// locally because both packages are L1 (imports point downward, never sideways).
// Fail-closed: an observed HCI fact without a complete envelope cannot be built.

/** Version of the HCI REST response → observed fact mappers in this package.
 *  Bump on any mapping change so stored facts stay attributable to their code. */
export const HCI_MAPPER_VERSION = '1.0.0';

/** Collector identity stamped on every REST-collected fact. */
export const HCI_COLLECTOR = 'hci-rest-collector';

export type HciFactTransport = 'api' | 'browser';

/** How a value was captured. The collector's CLAIM, not a vendor citation. */
export interface HciFactProvenance {
  transport: HciFactTransport;
  endpoint: string;
  menuPath?: string[];
  firmwareVersion?: string;
  mapperVersion: string;
  /** Measured round-trip time; only present when actually measured (> 0). */
  latencyMs?: number;
  authPrincipal?: string;
  collectedAt: string;
  collector: string;
}

/** An observed HCI fact: the value plus the envelope describing its origin. */
export interface HciObservedFact { value: unknown; source: HciFactProvenance; }

export class MissingProvenanceError extends Error {
  override readonly name = 'MissingProvenanceError';
  constructor(reason: string) {
    super(`MISSING_PROVENANCE: ${reason}`);
  }
}

const TRANSPORTS: readonly HciFactTransport[] = ['api', 'browser'];

function provenanceDefect(input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'provenance envelope is required for every observed fact';
  const p = input as Record<string, unknown>;
  for (const field of ['endpoint', 'mapperVersion', 'collectedAt', 'collector'] as const) {
    if (typeof p[field] !== 'string' || (p[field] as string).length === 0) return `provenance.${field} is required`;
  }
  if (typeof p.transport !== 'string' || !TRANSPORTS.includes(p.transport as HciFactTransport)) {
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

export function isHciFactProvenance(input: unknown): input is HciFactProvenance {
  return provenanceDefect(input) === null;
}

export function assertHciFactProvenance(input: unknown): asserts input is HciFactProvenance {
  const defect = provenanceDefect(input);
  if (defect) throw new MissingProvenanceError(defect);
}

/** Build an observed HCI fact. Refused rather than defaulted when unauditable. */
export function createHciObservedFact(value: unknown, provenance: HciFactProvenance): HciObservedFact {
  assertHciFactProvenance(provenance);
  return { value, source: provenance };
}

/** Envelope fields the caller may add on top of what the transport measures. */
export interface HciCollectionOptions {
  collectedAt?: string;
  collector?: string;
  firmwareVersion?: string;
  authPrincipal?: string;
}

/** Compose the envelope for one measured REST read. latencyMs is included only
 *  when the measurement is positive — a 0ms claim would be a fabrication. */
export function hciRestProvenance(
  endpoint: string,
  measured: { latencyMs: number; collectedAt: string },
  opts: HciCollectionOptions = {},
): HciFactProvenance {
  const provenance: HciFactProvenance = {
    transport: 'api',
    endpoint,
    mapperVersion: HCI_MAPPER_VERSION,
    collectedAt: opts.collectedAt ?? measured.collectedAt,
    collector: opts.collector ?? HCI_COLLECTOR,
    ...(measured.latencyMs > 0 ? { latencyMs: measured.latencyMs } : {}),
    ...(opts.firmwareVersion !== undefined ? { firmwareVersion: opts.firmwareVersion } : {}),
    ...(opts.authPrincipal !== undefined ? { authPrincipal: opts.authPrincipal } : {}),
  };
  assertHciFactProvenance(provenance);
  return provenance;
}

/** Run one measured REST read: times it and returns the payload with its envelope. */
export async function measureRestRead<T>(
  endpoint: string,
  read: () => Promise<T>,
  opts: HciCollectionOptions = {},
): Promise<{ result: T; provenance: HciFactProvenance }> {
  const collectedAt = new Date().toISOString();
  const started = performance.now();
  const result = await read();
  const latencyMs = performance.now() - started;
  return { result, provenance: hciRestProvenance(endpoint, { latencyMs, collectedAt }, opts) };
}
