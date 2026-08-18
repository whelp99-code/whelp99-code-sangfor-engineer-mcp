/**
 * Unapproved-drift read model (design 002, block B1).
 *
 * Joins a device's snapshot chain against approvals supplied by the caller.
 * Approvals are injected data, never imported: this package sits at L1 and must
 * not reach up into the approval/change-management layers. A drift node whose
 * capturedAt falls inside an approval window for the same device is expected
 * change; anything else is a finding. Pure read — nothing here writes.
 */
import { getHead, listSnapshots } from './store.js';

export interface ChangeApproval {
  changeTicketId: string;
  deviceId: string;
  approvedAt: string;
  windowStartAt?: string;
  windowEndAt?: string;
}

export interface UnapprovedDriftFinding {
  type: 'unapproved-drift';
  deviceId: string;
  snapshotHash: string;
  keys: string[];
  capturedAt: string;
}

export interface FindUnapprovedDriftInput {
  deviceId: string;
  dir: string;
  approvals: readonly ChangeApproval[];
}

function toEpoch(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`Invalid timestamp "${iso}"`);
  return ms;
}

/**
 * Window bounds are inclusive. A missing windowStartAt falls back to approvedAt
 * and a missing windowEndAt leaves the window open-ended — an approval with no
 * declared window covers everything from its approval instant onward.
 */
function covers(approval: ChangeApproval, capturedAtMs: number): boolean {
  const start = toEpoch(approval.windowStartAt ?? approval.approvedAt);
  if (capturedAtMs < start) return false;
  if (approval.windowEndAt === undefined) return true;
  return capturedAtMs <= toEpoch(approval.windowEndAt);
}

/**
 * Findings for every semantic drift on the device's chain that no approval
 * covers, oldest first. The genesis snapshot is baseline, not drift, so it is
 * never reported.
 */
export function findUnapprovedDrift(input: FindUnapprovedDriftInput): UnapprovedDriftFinding[] {
  const { deviceId, dir, approvals } = input;
  if (!getHead(deviceId, dir)) return [];
  const relevant = approvals.filter((a) => a.deviceId === deviceId);

  const findings: UnapprovedDriftFinding[] = [];
  for (const snapshot of listSnapshots(deviceId, dir)) {
    if (snapshot.parentHash === undefined) continue; // baseline, not a change
    if (snapshot.diff.length === 0) continue;
    const capturedAtMs = toEpoch(snapshot.capturedAt);
    if (relevant.some((a) => covers(a, capturedAtMs))) continue;
    findings.push({
      type: 'unapproved-drift',
      deviceId,
      snapshotHash: snapshot.hash,
      keys: snapshot.diff.map((d) => d.key).sort(),
      capturedAt: snapshot.capturedAt,
    });
  }
  return findings;
}
