/**
 * Acquisition-health scorecard (design 002, block G4).
 *
 * Four measured metrics decide a device's data-quality tier, and the tier — not
 * a human's optimism — decides how much autonomy that device gets. Two rules
 * keep the gate honest:
 *
 *  1. Hysteresis. A boundary-hugging device would otherwise toggle automation on
 *     and off every collection cycle. A tier changes only after the candidate
 *     tier has held continuously for `holdDurationSec`; any observation that
 *     disagrees restarts that dwell, so oscillation never promotes or demotes.
 *  2. A manual pin is an override, not a secret. It carries actor + reason and
 *     produces the ledger entry that records it.
 *
 * Pure: the caller owns the clock (every observation carries `at`) and the
 * persisted state (`TierState` goes out and comes back in).
 */
export type Tier = 'bronze' | 'silver' | 'gold';

export interface ScorecardMetrics {
  /** Observation timestamp (ISO-8601). The caller owns the clock. */
  at: string;
  /** Fraction of scheduled collections that succeeded. Higher is better. */
  collectionSuccessRate: number;
  /** Fraction of observed keys inside their freshness SLO. Higher is better. */
  freshnessAttainment: number;
  /** Fraction of cross-checked facts where two paths disagreed. LOWER is better. */
  corroborationDivergence: number;
  /** Fraction of the declared spec corpus actually covered. Higher is better. */
  corpusCoverage: number;
}

export interface TierBoundary {
  collectionSuccessRate: number;
  freshnessAttainment: number;
  /** Maximum tolerated divergence — the only inverted metric. */
  corroborationDivergence: number;
  corpusCoverage: number;
}

export interface TierThresholds {
  /** How long a candidate tier must hold before the tier actually moves. */
  holdDurationSec: number;
  gold: TierBoundary;
  silver: TierBoundary;
}

export interface TierState {
  tier: Tier;
  /** When the effective tier last changed. */
  sinceAt: string;
  /** Tier the raw metrics currently argue for. */
  candidateTier: Tier;
  /** When the candidate tier last started holding continuously. */
  candidateSinceAt: string;
}

export interface TierResult extends TierState {
  /** True when this observation moved the effective tier (or set it initially). */
  changed: boolean;
}

export interface TierPin {
  tier: Tier;
  pinnedBy: string;
  reason: string;
  at: string;
}

export interface TierPinLedgerEntry {
  type: 'scorecard-tier-pinned';
  previousTier: Tier;
  tier: Tier;
  pinnedBy: string;
  reason: string;
  at: string;
}

export interface PinnedTierResult {
  tier: Tier;
  pinned: true;
  sinceAt: string;
  ledgerEntry: TierPinLedgerEntry;
}

export type AutonomyCapability = 'observe' | 'assemble-dossier' | 'auto-close' | 'cross-device-spec';

/** Capabilities that require measured Gold-tier data quality. */
const GOLD_ONLY: readonly AutonomyCapability[] = ['auto-close', 'cross-device-spec'];
/** Non-mutating capabilities allowed at any tier. */
const ALWAYS_ALLOWED: readonly AutonomyCapability[] = ['observe', 'assemble-dossier'];

function meets(metrics: ScorecardMetrics, boundary: TierBoundary): boolean {
  return (
    metrics.collectionSuccessRate >= boundary.collectionSuccessRate &&
    metrics.freshnessAttainment >= boundary.freshnessAttainment &&
    metrics.corroborationDivergence <= boundary.corroborationDivergence &&
    metrics.corpusCoverage >= boundary.corpusCoverage
  );
}

function candidateTierOf(metrics: ScorecardMetrics, thresholds: TierThresholds): Tier {
  if (meets(metrics, thresholds.gold)) return 'gold';
  if (meets(metrics, thresholds.silver)) return 'silver';
  return 'bronze';
}

function elapsedSec(fromIso: string, toIso: string): number {
  return (Date.parse(toIso) - Date.parse(fromIso)) / 1000;
}

/**
 * Fold one metric observation into the device's tier state.
 *
 * With no `previous` the metrics decide the tier outright. Otherwise the raw
 * candidate is tracked separately from the effective tier: the effective tier
 * only adopts the candidate once that candidate has held for `holdDurationSec`,
 * and any disagreeing observation resets the candidate dwell to `metrics.at`.
 */
export function computeTier(
  metrics: ScorecardMetrics,
  thresholds: TierThresholds,
  previous?: TierState,
): TierResult {
  const candidate = candidateTierOf(metrics, thresholds);
  if (!previous) {
    return {
      tier: candidate,
      sinceAt: metrics.at,
      candidateTier: candidate,
      candidateSinceAt: metrics.at,
      changed: true,
    };
  }

  const candidateSinceAt = previous.candidateTier === candidate ? previous.candidateSinceAt : metrics.at;

  if (candidate === previous.tier) {
    // Back on the effective tier: nothing pending, nothing moves.
    return {
      tier: previous.tier,
      sinceAt: previous.sinceAt,
      candidateTier: candidate,
      candidateSinceAt,
      changed: false,
    };
  }

  const held = elapsedSec(candidateSinceAt, metrics.at) >= thresholds.holdDurationSec;
  if (!held) {
    return {
      tier: previous.tier,
      sinceAt: previous.sinceAt,
      candidateTier: candidate,
      candidateSinceAt,
      changed: false,
    };
  }

  return {
    tier: candidate,
    sinceAt: metrics.at,
    candidateTier: candidate,
    candidateSinceAt: metrics.at,
    changed: true,
  };
}

/**
 * Apply a manual tier override. Fails closed on an unattributed or unexplained
 * pin — an override nobody signed is indistinguishable from a bug.
 */
export function pinTier(current: TierState, pin: TierPin): PinnedTierResult {
  if (pin.pinnedBy.trim() === '') throw new Error('pinTier: pinnedBy is required — an override must name its actor');
  if (pin.reason.trim() === '') throw new Error('pinTier: reason is required — an override must record why');

  return {
    tier: pin.tier,
    pinned: true,
    sinceAt: pin.at,
    ledgerEntry: {
      type: 'scorecard-tier-pinned',
      previousTier: current.tier,
      tier: pin.tier,
      pinnedBy: pin.pinnedBy,
      reason: pin.reason,
      at: pin.at,
    },
  };
}

/** Gold-only for anything that closes a finding or reasons across devices; deny unknown capabilities. */
export function autonomyAllowed(tier: Tier, capability: AutonomyCapability): boolean {
  if (ALWAYS_ALLOWED.includes(capability)) return true;
  if (GOLD_ONLY.includes(capability)) return tier === 'gold';
  return false;
}
