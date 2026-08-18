/**
 * Canonical JSON for the engineer-report ledger (design 002, block F1).
 *
 * The hash chain must be reproducible across processes and machines, so the
 * preimage cannot depend on property insertion order: keys are sorted
 * recursively before serialization. Arrays keep their order — the order of
 * recommendations or engine items is meaningful content, not incidental.
 */

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] === undefined) continue;
      sorted[key] = canonicalValue(source[key]);
    }
    return sorted;
  }
  return value;
}

/** Deterministic JSON string for `value` with all object keys sorted recursively. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

/** Structural deep equality over the canonical form (key order insensitive). */
export function canonicalEquals(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** A structured deep clone that also drops undefined-valued keys, matching the preimage. */
export function canonicalClone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}
