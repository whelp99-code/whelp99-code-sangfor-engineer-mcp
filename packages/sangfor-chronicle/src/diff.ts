/**
 * Canonical JSON + semantic diff for the config chronicle (design 002, B1).
 *
 * Canonical form is the hashed preimage of a snapshot: keys sorted recursively
 * so that two captures which differ only in property order collapse to the same
 * content address. Ephemeral keys (uptime, counters, timestamps the device
 * bumps on its own) are excluded from that preimage — otherwise every poll
 * would look like drift and the DAG would grow one node per poll forever.
 */

import { parseBoundaryChronicleCanonicalV1 } from './runtime-boundaries.js';

export type ChangeClass = 'added' | 'removed' | 'changed';

export interface SemanticChange {
  key: string;
  before?: unknown;
  after?: unknown;
  changeClass: ChangeClass;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = canonicalValue(source[key]);
    return sorted;
  }
  return value;
}

/**
 * Deterministic JSON for `observed` with `ephemeralKeys` (top-level) removed.
 * Undefined-valued top-level keys are dropped, matching JSON.stringify, so a
 * key explicitly set to undefined is indistinguishable from an absent one.
 */
export function canonicalize(
  observed: Record<string, unknown>,
  ephemeralKeys: readonly string[] = [],
): string {
  const excluded = new Set(ephemeralKeys);
  const stable: Record<string, unknown> = {};
  for (const key of Object.keys(observed).sort()) {
    if (excluded.has(key)) continue;
    if (observed[key] === undefined) continue;
    stable[key] = canonicalValue(observed[key]);
  }
  return JSON.stringify(stable);
}

/** True when two values are equal under canonical (order-insensitive) JSON. */
function canonicalEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalValue(a)) === JSON.stringify(canonicalValue(b));
}

/**
 * Semantic diff between two already-canonicalized observation maps, key-sorted
 * so callers get a stable, reviewable change list. Ephemeral keys must already
 * be excluded by the caller (see `canonicalize`).
 */
export function semanticDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): SemanticChange[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const changes: SemanticChange[] = [];
  for (const key of keys) {
    const inBefore = Object.hasOwn(before, key);
    const inAfter = Object.hasOwn(after, key);
    if (inBefore && !inAfter) {
      changes.push({ key, before: before[key], after: undefined, changeClass: 'removed' });
    } else if (!inBefore && inAfter) {
      changes.push({ key, before: undefined, after: after[key], changeClass: 'added' });
    } else if (!canonicalEqual(before[key], after[key])) {
      changes.push({ key, before: before[key], after: after[key], changeClass: 'changed' });
    }
  }
  return changes;
}

/** Parse a canonical JSON preimage back into its observation map. */
export function parseCanonical(canonical: string): Record<string, unknown> {
  return parseBoundaryChronicleCanonicalV1(canonical);
}
