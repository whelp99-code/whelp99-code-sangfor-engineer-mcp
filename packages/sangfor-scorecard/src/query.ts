/**
 * Snapshot query language (design 002, block H1).
 *
 * Answers fleet questions like "HCI below 6.11 whose MTU is not 9000" over
 * chronicle chains, optionally at a point in time. Chains arrive as an argument
 * (typically `listSnapshots(deviceId, dir)` per device) so this stays pure and
 * the same query runs against a store, a fixture, or an in-memory projection.
 *
 * The honesty rule: absence is never a match. A device with no snapshot at all,
 * no snapshot at-or-before `asOf`, or a snapshot that simply lacks the queried
 * key is reported under `noData` with the reason — it is never silently folded
 * into a `neq` result, which is exactly how "not 9000" queries grow phantom
 * devices.
 */
export interface QuerySnapshot {
  capturedAt: string;
  observed: Record<string, unknown>;
  deviceId?: string;
}

export type QueryChains = Record<string, readonly QuerySnapshot[]>;

export type QueryOp = 'eq' | 'neq' | 'lt' | 'gte' | 'exists';

export interface QueryPredicate {
  key: string;
  op: QueryOp;
  value: unknown;
}

export interface QueryDevicesInput {
  chains: QueryChains;
  where: QueryPredicate;
  /** ISO-8601 point in time; the newest snapshot at or before it wins. */
  asOf?: string;
}

export interface QueryMatch {
  deviceId: string;
  /** The observed value that satisfied the predicate. */
  value: unknown;
  /** capturedAt of the snapshot the match was read from. */
  capturedAt: string;
}

export type NoDataReason = 'no-snapshot' | 'no-snapshot-before-asOf' | 'key-absent';

export interface QueryNoData {
  deviceId: string;
  reason: NoDataReason;
}

export interface QueryDevicesResult {
  matches: QueryMatch[];
  noData: QueryNoData[];
}

function pickSnapshot(
  snapshots: readonly QuerySnapshot[],
  asOf: string | undefined,
): QuerySnapshot | undefined {
  const eligible = asOf === undefined ? snapshots : snapshots.filter((snap) => snap.capturedAt <= asOf);
  let picked: QuerySnapshot | undefined;
  for (const snap of eligible) {
    // Explicit max by capturedAt: array order is a storage detail, not a promise.
    if (!picked || snap.capturedAt > picked.capturedAt) picked = snap;
  }
  return picked;
}

const OPS: readonly QueryOp[] = ['eq', 'neq', 'lt', 'gte', 'exists'];
const DOTTED_VERSION_RE = /^\d+(\.\d+)*$/u;

/**
 * Order two operands. Dotted numeric strings ('6.8.0' vs '6.11') compare
 * segment-by-segment as numbers — lexicographic order would rank 6.8.0 above
 * 6.11.0 and quietly drop the very devices a "below 6.11" query is asked to
 * find. Everything else uses natural JS ordering.
 */
function order(observed: unknown, expected: unknown): number {
  if (
    typeof observed === 'string' && typeof expected === 'string' &&
    DOTTED_VERSION_RE.test(observed) && DOTTED_VERSION_RE.test(expected)
  ) {
    const left = observed.split('.').map(Number);
    const right = expected.split('.').map(Number);
    for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
      const a = left[i] ?? 0;
      const b = right[i] ?? 0;
      if (a !== b) return a < b ? -1 : 1;
    }
    return 0;
  }
  const a = observed as number | string;
  const b = expected as number | string;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compare(op: QueryOp, observed: unknown, expected: unknown): boolean {
  switch (op) {
    case 'exists':
      return true; // presence already checked by the caller
    case 'eq':
      return observed === expected;
    case 'neq':
      return observed !== expected;
    case 'lt':
      return order(observed, expected) < 0;
    case 'gte':
      return order(observed, expected) >= 0;
  }
}

/**
 * Evaluate one predicate across every device chain. Results are ordered by
 * deviceId so a query is reproducible regardless of chain insertion order.
 */
export function queryDevices(input: QueryDevicesInput): QueryDevicesResult {
  const { chains, where, asOf } = input;
  // Reject an unknown operator up front: an empty result set must mean "nothing
  // matched", never "the query was nonsense".
  if (!OPS.includes(where.op)) throw new Error(`Unknown query operator "${String(where.op)}"`);
  const matches: QueryMatch[] = [];
  const noData: QueryNoData[] = [];

  for (const deviceId of Object.keys(chains).sort()) {
    const snapshots = chains[deviceId] ?? [];
    if (snapshots.length === 0) {
      noData.push({ deviceId, reason: 'no-snapshot' });
      continue;
    }
    const snapshot = pickSnapshot(snapshots, asOf);
    if (!snapshot) {
      noData.push({ deviceId, reason: 'no-snapshot-before-asOf' });
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(snapshot.observed, where.key)) {
      noData.push({ deviceId, reason: 'key-absent' });
      continue;
    }
    const value = snapshot.observed[where.key];
    if (compare(where.op, value, where.value)) {
      matches.push({ deviceId, value, capturedAt: snapshot.capturedAt });
    }
  }

  return { matches, noData };
}
