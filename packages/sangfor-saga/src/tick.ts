/**
 * PM saga coordinator — dispatch half (design 002, block F3).
 *
 * A pure function of the world the caller read: open findings, live leases,
 * device locks, budgets and `now`. No timers, no clock reads, no file IO, no
 * LLM. The tick loop that owns the ledger calls this, writes what it returns,
 * and calls it again — so a crash between two ticks costs nothing and the same
 * inputs always produce the same work items.
 *
 * Two invariants it exists to hold:
 *  1. Never two live work items for one device — a lease or an injected device
 *     lock (from @sangfor/pm) blocks that device for this tick.
 *  2. Budgets come from the input. A missing budget is an error, never a
 *     hardcoded default that silently lies to the worker about its ceiling.
 */
import { createHash } from 'node:crypto';
import type { DeviceLock } from '@sangfor/pm';

export interface BudgetSpec {
  maxTokens: number;
  maxToolCalls: number;
  /** Seconds from `now` until the work item's hard deadline. */
  deadlineSeconds: number;
  /** Seconds from `now` the issued lease stays valid. Falls back to the tick default. */
  leaseSeconds?: number;
}

export interface OpenFinding {
  findingId: string;
  deviceId: string;
  agentKind: string;
  severity: 'must' | 'recommended';
  openedAt: string;
  /** Per-finding override of the tick-level budget. */
  budget?: BudgetSpec;
}

export interface Lease {
  deviceId: string;
  workItemId: string;
  leaseUntil: string;
}

export interface WorkItemBudget {
  maxTokens: number;
  maxToolCalls: number;
  deadlineAt: string;
}

export interface WorkItem {
  workItemId: string;
  findingId: string;
  deviceId: string;
  agentKind: string;
  budget: WorkItemBudget;
  leaseUntil: string;
}

export interface TickInput {
  openFindings: readonly OpenFinding[];
  leases: readonly Lease[];
  deviceLocks: readonly DeviceLock[];
  budgets?: BudgetSpec;
  now: string;
  /** Upper bound on simultaneously live work items (issued + already leased). */
  maxConcurrentWorkItems?: number;
}

function requireBudget(finding: OpenFinding, fallback: BudgetSpec | undefined): BudgetSpec {
  const budget = finding.budget ?? fallback;
  if (!budget) {
    throw new Error(
      `No budget for finding ${finding.findingId}: tick requires budgets from its input — a default here would misreport the worker's real ceiling`,
    );
  }
  for (const field of ['maxTokens', 'maxToolCalls', 'deadlineSeconds'] as const) {
    const value = budget[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new Error(`Invalid budget.${field} for finding ${finding.findingId}: must be a positive number`);
    }
  }
  return budget;
}

function isoPlusSeconds(nowMs: number, seconds: number): string {
  return new Date(nowMs + seconds * 1000).toISOString();
}

/** Stable id derived from the dispatch identity — same tick input, same id. */
function workItemId(finding: OpenFinding, now: string): string {
  const digest = createHash('sha256')
    .update(`${finding.findingId}|${finding.deviceId}|${finding.agentKind}|${now}`)
    .digest('hex');
  return `wi_${digest.slice(0, 16)}`;
}

/**
 * Issue work items for the findings that may run right now. Deterministic:
 * findings are processed in (findingId, deviceId) order, so the same world
 * always yields byte-identical output regardless of input ordering.
 */
export function tick(input: TickInput): WorkItem[] {
  const nowMs = Date.parse(input.now);
  if (Number.isNaN(nowMs)) throw new Error(`Invalid now "${input.now}": must be an ISO timestamp`);

  const blockedDevices = new Set<string>();
  let liveCount = 0;
  for (const lease of input.leases) {
    // A lease expiring exactly at now is spent — the worker's window is over,
    // so the device is reclaimable rather than parked until the next tick.
    if (Date.parse(lease.leaseUntil) > nowMs) {
      blockedDevices.add(lease.deviceId);
      liveCount += 1;
    }
  }
  for (const lock of input.deviceLocks) blockedDevices.add(lock.deviceId);

  const ordered = [...input.openFindings].sort((a, b) =>
    a.findingId.localeCompare(b.findingId) || a.deviceId.localeCompare(b.deviceId));

  const cap = input.maxConcurrentWorkItems ?? Number.POSITIVE_INFINITY;
  const items: WorkItem[] = [];
  for (const finding of ordered) {
    if (liveCount >= cap) break;
    if (blockedDevices.has(finding.deviceId)) continue;
    const budget = requireBudget(finding, input.budgets);
    const leaseSeconds = budget.leaseSeconds ?? input.budgets?.leaseSeconds ?? budget.deadlineSeconds;
    items.push({
      workItemId: workItemId(finding, input.now),
      findingId: finding.findingId,
      deviceId: finding.deviceId,
      agentKind: finding.agentKind,
      budget: {
        maxTokens: budget.maxTokens,
        maxToolCalls: budget.maxToolCalls,
        deadlineAt: isoPlusSeconds(nowMs, budget.deadlineSeconds),
      },
      leaseUntil: isoPlusSeconds(nowMs, leaseSeconds),
    });
    // Claimed for this tick: a second finding on the same device waits its turn.
    blockedDevices.add(finding.deviceId);
    liveCount += 1;
  }
  return items;
}
