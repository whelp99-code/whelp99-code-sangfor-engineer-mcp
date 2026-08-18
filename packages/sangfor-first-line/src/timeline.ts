/**
 * Change-correlated timeline read model (design 002, block B3).
 *
 * Config diffs, health events, change approvals and agent findings are merged
 * into one ordered read model. All four arrive as injected arrays: this package
 * sits at L1 and must not reach up into chronicle storage, the approval spine
 * or the agent layer to fetch them.
 *
 * Clock honesty is the point. A health event carries both the device clock and
 * the collector clock; when they disagree the entry keeps both, reports the
 * skew, and is marked `skewed`. Ordering always uses the device-reported
 * instant, so a skewed entry is never silently shuffled into a position its own
 * clock does not support — the reader is told the ordering is uncertain instead.
 */

export type OrderingConfidence = 'exact' | 'skewed';

export type TimelineKind = 'approval' | 'config-diff' | 'finding' | 'health-event';

export interface TimelineDiffInput {
  deviceId: string;
  snapshotHash: string;
  capturedAt: string;
  keys: readonly string[];
  collectorObservedAt?: string;
}

export interface TimelineHealthEventInput {
  deviceId: string;
  eventId: string;
  severity: string;
  summary: string;
  deviceReportedAt: string;
  collectorObservedAt: string;
}

export interface TimelineApprovalInput {
  deviceId: string;
  changeTicketId: string;
  approvedAt: string;
}

export interface TimelineFindingInput {
  deviceId: string;
  findingKey: string;
  state: string;
  detectedAt: string;
}

export interface BuildTimelineInput {
  diffs: readonly TimelineDiffInput[];
  healthEvents: readonly TimelineHealthEventInput[];
  approvals: readonly TimelineApprovalInput[];
  findings: readonly TimelineFindingInput[];
  /** Optional scope filter; omit to merge every device in the inputs. */
  deviceId?: string;
}

export interface TimelineEntry {
  id: string;
  kind: TimelineKind;
  deviceId: string;
  /** Ordering key — always the device-reported instant. */
  at: string;
  deviceReportedAt: string;
  collectorObservedAt: string;
  orderingConfidence: OrderingConfidence;
  /** Present only when the two clocks disagree. */
  skewMs?: number;
  source: Record<string, unknown>;
}

function toEpoch(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`Invalid timestamp "${iso}"`);
  return ms;
}

function entry(
  kind: TimelineKind,
  id: string,
  deviceId: string,
  deviceReportedAt: string,
  collectorObservedAt: string,
  source: Record<string, unknown>,
): TimelineEntry {
  const skewMs = toEpoch(collectorObservedAt) - toEpoch(deviceReportedAt);
  const base: TimelineEntry = {
    id: `${kind}:${id}`,
    kind,
    deviceId,
    at: deviceReportedAt,
    deviceReportedAt,
    collectorObservedAt,
    orderingConfidence: skewMs === 0 ? 'exact' : 'skewed',
    source,
  };
  return skewMs === 0 ? base : { ...base, skewMs };
}

export function buildTimeline(input: BuildTimelineInput): TimelineEntry[] {
  const scoped = <T extends { deviceId: string }>(rows: readonly T[]): readonly T[] =>
    input.deviceId === undefined ? rows : rows.filter((r) => r.deviceId === input.deviceId);

  const entries: TimelineEntry[] = [
    ...scoped(input.approvals).map((a) =>
      entry('approval', a.changeTicketId, a.deviceId, a.approvedAt, a.approvedAt, {
        changeTicketId: a.changeTicketId,
      }),
    ),
    ...scoped(input.diffs).map((d) =>
      // A diff has one device-side capture instant; a collector timestamp is
      // optional and defaults to it (no skew claimed without evidence).
      entry('config-diff', d.snapshotHash, d.deviceId, d.capturedAt, d.collectorObservedAt ?? d.capturedAt, {
        snapshotHash: d.snapshotHash,
        keys: [...d.keys],
      }),
    ),
    ...scoped(input.findings).map((f) =>
      entry('finding', f.findingKey, f.deviceId, f.detectedAt, f.detectedAt, {
        findingKey: f.findingKey,
        state: f.state,
      }),
    ),
    ...scoped(input.healthEvents).map((h) =>
      entry('health-event', h.eventId, h.deviceId, h.deviceReportedAt, h.collectorObservedAt, {
        eventId: h.eventId,
        severity: h.severity,
        summary: h.summary,
      }),
    ),
  ];

  // Ties break on id (kind-prefixed) so two runs over the same data produce the
  // same read model — a timeline that reshuffles is not auditable.
  return entries.sort(
    (a, b) => toEpoch(a.at) - toEpoch(b.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}
