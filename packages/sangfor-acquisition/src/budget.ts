/**
 * Per-device API budget manager (design 002, block A5).
 *
 * Collection must never be the reason a managed device falls over. Every batch
 * of calls is planned against the device's own budget (concurrency + trailing
 * rate) using a ledger the caller persists; the planner is pure and takes `now`
 * as an argument so a plan is reproducible from the ledger alone.
 *
 * Fail-closed: an unparseable ledger entry, an over-committed inFlight count or
 * a nonsensical budget yields NO headroom. Under-collecting is recoverable;
 * hammering a struggling device is not. Every plan — including an empty one —
 * emits a loadRecord so the evidence trail of collection load has no holes.
 */

export interface ApiBudget {
  maxConcurrent: number;
  maxPerMinute: number;
}

export interface PlannedCall {
  id: string;
  observedKey?: string;
  endpoint?: string;
}

export interface CallLedger {
  /** Calls issued to this device and not yet completed. */
  inFlight: number;
  /** ISO instants of recently issued calls; entries outside the trailing minute are ignored. */
  recentCallsAt: readonly string[];
}

/** The load this collection put on the device — persisted by the caller as evidence. */
export interface CollectionLoadRecord {
  deviceId: string;
  allowedCount: number;
  deferredCount: number;
  at: string;
}

export interface PlanCallsInput {
  deviceId: string;
  requested: readonly PlannedCall[];
  budget: ApiBudget;
  ledger: CallLedger;
  now: string;
}

export interface CallPlan {
  allowed: PlannedCall[];
  deferred: PlannedCall[];
  loadRecord: CollectionLoadRecord;
}

const WINDOW_MS = 60_000;

function isPositiveInteger(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/** Count ledger entries inside the trailing minute; an unparseable stamp counts as recent. */
function recentCount(recentCallsAt: readonly string[], nowMs: number): number {
  let count = 0;
  for (const stamp of recentCallsAt) {
    const ms = Date.parse(stamp);
    if (Number.isNaN(ms)) { count += 1; continue; }
    if (nowMs - ms < WINDOW_MS) count += 1;
  }
  return count;
}

/**
 * Split the requested calls into what the budget permits right now and what must
 * wait, preserving the caller's priority order. Headroom is the tighter of the
 * concurrency and rate limits and is never negative.
 */
export function planCalls(input: PlanCallsInput): CallPlan {
  const { deviceId, requested, budget, ledger, now } = input;
  const nowMs = Date.parse(now);

  const budgetUsable = isPositiveInteger(budget.maxConcurrent) && isPositiveInteger(budget.maxPerMinute);
  const inFlight = Number.isFinite(ledger.inFlight) && ledger.inFlight > 0 ? ledger.inFlight : 0;
  const concurrencyHeadroom = Math.max(0, budget.maxConcurrent - inFlight);
  const rateHeadroom = Number.isNaN(nowMs)
    ? 0
    : Math.max(0, budget.maxPerMinute - recentCount(ledger.recentCallsAt, nowMs));

  const headroom = budgetUsable ? Math.min(concurrencyHeadroom, rateHeadroom) : 0;
  const allowed = requested.slice(0, headroom);
  const deferred = requested.slice(allowed.length);

  return {
    allowed,
    deferred,
    loadRecord: { deviceId, allowedCount: allowed.length, deferredCount: deferred.length, at: now },
  };
}
