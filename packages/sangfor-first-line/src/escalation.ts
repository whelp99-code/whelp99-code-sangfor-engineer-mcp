/**
 * Non-mutating first-line escalation ladder (design 002, blocks E1 and E2).
 *
 * detected -> corroborated -> enriched -> (auto-resolved-observed | escalated).
 *
 * Two invariants are encoded in the types, not in a comment:
 *   1. Nothing here can authorise a device write. There is no approval, nonce,
 *      signature or command field anywhere in this module, so a caller cannot
 *      smuggle a mutation through the ladder; configuration changes must go the
 *      long way round through the approval spine.
 *   2. Transitions are pure. Each returns the next finding plus the ledger entry
 *      the caller is responsible for persisting; this module performs no IO and
 *      mutates no input.
 *
 * Auto-resolution requires observed clearing evidence — "the alarm stopped
 * firing" is not evidence, a re-collection that shows the condition gone is.
 * Repeated auto-resolution is itself a symptom, so the Nth auto-resolve of the
 * same findingKey inside the caller's window is forced to `escalated`.
 */

export type FindingState =
  | 'detected'
  | 'corroborated'
  | 'enriched'
  | 'auto-resolved-observed'
  | 'escalated';

export interface ClearingEvidence {
  observedAt: string;
  source: string;
  detail?: string;
}

export interface Finding {
  findingKey: string;
  deviceId: string;
  state: FindingState;
  dossierRef?: string;
  corroboratingSource?: string;
  escalationTarget?: string;
  clearingEvidence?: ClearingEvidence;
  escalationReason?: LedgerReason;
}

export interface FlapPolicy {
  /** Auto-resolves (including the one being attempted) that force escalation. */
  maxAutoResolves: number;
  windowMs: number;
}

export type FindingEvent =
  | { type: 'corroborate'; corroboratingSource: string }
  | { type: 'enrich'; dossierRef: string }
  | { type: 'escalate'; escalationTarget: string }
  | {
      type: 'auto-resolve';
      clearingEvidence: ClearingEvidence;
      flapPolicy?: FlapPolicy;
      priorAutoResolvedAt?: readonly string[];
    };

export type LedgerReason =
  | 'corroborated-by-second-source'
  | 'dossier-assembled'
  | 'escalated-to-human'
  | 'clearing-evidence-observed'
  | 'flapping';

export interface FindingLedgerEntry {
  findingKey: string;
  deviceId: string;
  from: FindingState;
  to: FindingState;
  at: string;
  reason: LedgerReason;
}

export interface AdvanceFindingInput {
  finding: Finding;
  event: FindingEvent;
  at: string;
}

export interface AdvanceFindingResult {
  next: Finding;
  ledgerEntry: FindingLedgerEntry;
}

const LEGAL_FROM: Record<FindingEvent['type'], readonly FindingState[]> = {
  corroborate: ['detected'],
  enrich: ['corroborated'],
  escalate: ['corroborated', 'enriched'],
  'auto-resolve': ['enriched'],
};

function toEpoch(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`Invalid timestamp "${iso}"`);
  return ms;
}

function assertLegal(event: FindingEvent, from: FindingState): void {
  const legal = LEGAL_FROM[event.type];
  if (legal === undefined) throw new Error(`Unknown finding event type "${event.type}"`);
  if (!legal.includes(from)) {
    throw new Error(
      `Illegal transition: "${event.type}" is not allowed from state "${from}" (allowed: ${legal.join(', ')})`,
    );
  }
}

/** True when this auto-resolve is the Nth inside the policy window. */
function isFlapping(
  atMs: number,
  policy: FlapPolicy | undefined,
  priorAutoResolvedAt: readonly string[],
): boolean {
  if (!policy) return false;
  // Window bounds inclusive: a prior resolve exactly windowMs old still counts.
  const inWindow = priorAutoResolvedAt.filter((iso) => atMs - toEpoch(iso) <= policy.windowMs);
  return inWindow.length + 1 >= policy.maxAutoResolves;
}

export function advanceFinding(input: AdvanceFindingInput): AdvanceFindingResult {
  const { finding, event, at } = input;
  assertLegal(event, finding.state);
  const from = finding.state;

  const ledger = (to: FindingState, reason: LedgerReason): FindingLedgerEntry => ({
    findingKey: finding.findingKey,
    deviceId: finding.deviceId,
    from,
    to,
    at,
    reason,
  });

  switch (event.type) {
    case 'corroborate':
      return {
        next: { ...finding, state: 'corroborated', corroboratingSource: event.corroboratingSource },
        ledgerEntry: ledger('corroborated', 'corroborated-by-second-source'),
      };
    case 'enrich':
      return {
        next: { ...finding, state: 'enriched', dossierRef: event.dossierRef },
        ledgerEntry: ledger('enriched', 'dossier-assembled'),
      };
    case 'escalate':
      return {
        next: {
          ...finding,
          state: 'escalated',
          escalationTarget: event.escalationTarget,
          escalationReason: 'escalated-to-human',
        },
        ledgerEntry: ledger('escalated', 'escalated-to-human'),
      };
    case 'auto-resolve': {
      if (isFlapping(toEpoch(at), event.flapPolicy, event.priorAutoResolvedAt ?? [])) {
        // The condition keeps coming back: closing it again would hide a real
        // problem, so the ladder hands it to a human instead.
        return {
          next: {
            ...finding,
            state: 'escalated',
            clearingEvidence: event.clearingEvidence,
            escalationReason: 'flapping',
          },
          ledgerEntry: ledger('escalated', 'flapping'),
        };
      }
      return {
        next: {
          ...finding,
          state: 'auto-resolved-observed',
          clearingEvidence: event.clearingEvidence,
        },
        ledgerEntry: ledger('auto-resolved-observed', 'clearing-evidence-observed'),
      };
    }
  }
}
