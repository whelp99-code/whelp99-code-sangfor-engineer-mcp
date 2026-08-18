import { describe, expect, it } from 'vitest';
import {
  autonomyAllowed,
  computeTier,
  pinTier,
  type ScorecardMetrics,
  type TierState,
  type TierThresholds,
} from '../packages/sangfor-scorecard/src/index.js';

const thresholds: TierThresholds = {
  holdDurationSec: 3600,
  gold: { collectionSuccessRate: 0.99, freshnessAttainment: 0.98, corroborationDivergence: 0.01, corpusCoverage: 0.9 },
  silver: { collectionSuccessRate: 0.95, freshnessAttainment: 0.9, corroborationDivergence: 0.05, corpusCoverage: 0.7 },
};

const goldMetrics: ScorecardMetrics = {
  at: '2026-08-01T00:00:00.000Z',
  collectionSuccessRate: 0.995,
  freshnessAttainment: 0.99,
  corroborationDivergence: 0.005,
  corpusCoverage: 0.95,
};

const silverMetrics: ScorecardMetrics = {
  at: '2026-08-01T00:00:00.000Z',
  collectionSuccessRate: 0.96,
  freshnessAttainment: 0.93,
  corroborationDivergence: 0.03,
  corpusCoverage: 0.8,
};

const bronzeMetrics: ScorecardMetrics = {
  at: '2026-08-01T00:00:00.000Z',
  collectionSuccessRate: 0.5,
  freshnessAttainment: 0.4,
  corroborationDivergence: 0.4,
  corpusCoverage: 0.1,
};

function at(iso: string, metrics: ScorecardMetrics): ScorecardMetrics {
  return { ...metrics, at: iso };
}

describe('@sangfor/scorecard — tier computation (design 002, block G4)', () => {
  it('classifies a first observation with no previous state directly from the thresholds', () => {
    expect(computeTier(goldMetrics, thresholds).tier).toBe('gold');
    expect(computeTier(silverMetrics, thresholds).tier).toBe('silver');
    expect(computeTier(bronzeMetrics, thresholds).tier).toBe('bronze');
  });

  it('demands every metric clear the boundary — one bad metric caps the tier', () => {
    const oneBadMetric = { ...goldMetrics, corroborationDivergence: 0.04 };
    expect(computeTier(oneBadMetric, thresholds).tier).toBe('silver');
  });

  it('reports the candidate tier and its dwell start so the caller can feed state back', () => {
    const first = computeTier(silverMetrics, thresholds);
    expect(first).toEqual({
      tier: 'silver',
      sinceAt: '2026-08-01T00:00:00.000Z',
      candidateTier: 'silver',
      candidateSinceAt: '2026-08-01T00:00:00.000Z',
      changed: true,
    });
  });

  it('holds the current tier while a better candidate has not yet dwelled long enough (up)', () => {
    const previous: TierState = {
      tier: 'silver',
      sinceAt: '2026-08-01T00:00:00.000Z',
      candidateTier: 'silver',
      candidateSinceAt: '2026-08-01T00:00:00.000Z',
    };
    const next = computeTier(at('2026-08-01T00:10:00.000Z', goldMetrics), thresholds, previous);

    expect(next.tier).toBe('silver');
    expect(next.changed).toBe(false);
    expect(next.candidateTier).toBe('gold');
    expect(next.candidateSinceAt).toBe('2026-08-01T00:10:00.000Z');
    expect(next.sinceAt).toBe('2026-08-01T00:00:00.000Z');
  });

  it('promotes only after the better candidate has held for holdDurationSec', () => {
    const pending: TierState = {
      tier: 'silver',
      sinceAt: '2026-08-01T00:00:00.000Z',
      candidateTier: 'gold',
      candidateSinceAt: '2026-08-01T00:10:00.000Z',
    };
    const tooSoon = computeTier(at('2026-08-01T01:09:59.000Z', goldMetrics), thresholds, pending);
    expect(tooSoon.tier).toBe('silver');
    expect(tooSoon.changed).toBe(false);

    const ripe = computeTier(at('2026-08-01T01:10:00.000Z', goldMetrics), thresholds, pending);
    expect(ripe.tier).toBe('gold');
    expect(ripe.changed).toBe(true);
    expect(ripe.sinceAt).toBe('2026-08-01T01:10:00.000Z');
    expect(ripe.candidateTier).toBe('gold');
    expect(ripe.candidateSinceAt).toBe('2026-08-01T01:10:00.000Z');
  });

  it('holds the current tier while a worse candidate has not yet dwelled long enough (down)', () => {
    const previous: TierState = {
      tier: 'gold',
      sinceAt: '2026-08-01T00:00:00.000Z',
      candidateTier: 'gold',
      candidateSinceAt: '2026-08-01T00:00:00.000Z',
    };
    const next = computeTier(at('2026-08-01T00:30:00.000Z', bronzeMetrics), thresholds, previous);

    expect(next.tier).toBe('gold');
    expect(next.changed).toBe(false);
    expect(next.candidateTier).toBe('bronze');

    const ripe = computeTier(at('2026-08-01T01:30:00.000Z', bronzeMetrics), thresholds, {
      ...previous,
      candidateTier: 'bronze',
      candidateSinceAt: '2026-08-01T00:30:00.000Z',
    });
    expect(ripe.tier).toBe('bronze');
    expect(ripe.changed).toBe(true);
  });

  it('never flip-flops at the boundary: metrics oscillating across the gold line keep the tier stable', () => {
    let state: TierState = {
      tier: 'silver',
      sinceAt: '2026-08-01T00:00:00.000Z',
      candidateTier: 'silver',
      candidateSinceAt: '2026-08-01T00:00:00.000Z',
    };
    // Alternate above/below the gold boundary every 10 minutes for 4 hours —
    // far longer than holdDurationSec, but the candidate never dwells.
    const observed: Array<'gold' | 'silver'> = [];
    for (let minute = 10; minute <= 240; minute += 10) {
      const iso = new Date(Date.UTC(2026, 7, 1, 0, 0, 0) + minute * 60_000).toISOString();
      const metrics = minute % 20 === 0 ? at(iso, goldMetrics) : at(iso, silverMetrics);
      const result = computeTier(metrics, thresholds, state);
      observed.push(result.tier as 'gold' | 'silver');
      state = { tier: result.tier, sinceAt: result.sinceAt, candidateTier: result.candidateTier, candidateSinceAt: result.candidateSinceAt };
    }

    expect(new Set(observed)).toEqual(new Set(['silver']));
    expect(state.tier).toBe('silver');
    expect(state.sinceAt).toBe('2026-08-01T00:00:00.000Z');
  });

  it('promotes a candidate that stops oscillating and then holds the full duration', () => {
    let state: TierState = {
      tier: 'silver',
      sinceAt: '2026-08-01T00:00:00.000Z',
      candidateTier: 'silver',
      candidateSinceAt: '2026-08-01T00:00:00.000Z',
    };
    for (let minute = 10; minute <= 120; minute += 10) {
      const iso = new Date(Date.UTC(2026, 7, 1, 0, 0, 0) + minute * 60_000).toISOString();
      const result = computeTier(at(iso, goldMetrics), thresholds, state);
      state = { tier: result.tier, sinceAt: result.sinceAt, candidateTier: result.candidateTier, candidateSinceAt: result.candidateSinceAt };
    }
    expect(state.tier).toBe('gold');
    expect(state.sinceAt).toBe('2026-08-01T01:10:00.000Z');
  });
});

describe('@sangfor/scorecard — ledgered manual pin', () => {
  const current: TierState = {
    tier: 'bronze',
    sinceAt: '2026-08-01T00:00:00.000Z',
    candidateTier: 'bronze',
    candidateSinceAt: '2026-08-01T00:00:00.000Z',
  };

  it('overrides the computed tier and records who pinned it and why', () => {
    const pinned = pinTier(current, {
      tier: 'silver',
      pinnedBy: 'jm',
      reason: 'collector maintenance window, metrics known-degraded',
      at: '2026-08-02T09:00:00.000Z',
    });

    expect(pinned.tier).toBe('silver');
    expect(pinned.pinned).toBe(true);
    expect(pinned.ledgerEntry).toEqual({
      type: 'scorecard-tier-pinned',
      previousTier: 'bronze',
      tier: 'silver',
      pinnedBy: 'jm',
      reason: 'collector maintenance window, metrics known-degraded',
      at: '2026-08-02T09:00:00.000Z',
    });
    expect(pinned.sinceAt).toBe('2026-08-02T09:00:00.000Z');
  });

  it('rejects a pin with no stated reason — an override without a why is not auditable', () => {
    expect(() =>
      pinTier(current, { tier: 'gold', pinnedBy: 'jm', reason: '   ', at: '2026-08-02T09:00:00.000Z' }),
    ).toThrow(/reason/i);
  });

  it('rejects a pin with no named actor', () => {
    expect(() =>
      pinTier(current, { tier: 'gold', pinnedBy: '', reason: 'because', at: '2026-08-02T09:00:00.000Z' }),
    ).toThrow(/pinnedBy/i);
  });
});

describe('@sangfor/scorecard — autonomy gate', () => {
  it('allows auto-close and cross-device specs only for gold', () => {
    expect(autonomyAllowed('gold', 'auto-close')).toBe(true);
    expect(autonomyAllowed('gold', 'cross-device-spec')).toBe(true);

    expect(autonomyAllowed('silver', 'auto-close')).toBe(false);
    expect(autonomyAllowed('silver', 'cross-device-spec')).toBe(false);
    expect(autonomyAllowed('bronze', 'auto-close')).toBe(false);
    expect(autonomyAllowed('bronze', 'cross-device-spec')).toBe(false);
  });

  it('allows read-only capabilities at every tier', () => {
    for (const tier of ['bronze', 'silver', 'gold'] as const) {
      expect(autonomyAllowed(tier, 'observe')).toBe(true);
      expect(autonomyAllowed(tier, 'assemble-dossier')).toBe(true);
    }
  });

  it('denies an unknown capability at every tier (fail closed)', () => {
    for (const tier of ['bronze', 'silver', 'gold'] as const) {
      expect(autonomyAllowed(tier, 'reboot-cluster' as never)).toBe(false);
    }
  });
});
