// A1 (Step 7) — freshness budgets must be DERIVED FROM MEASURED capture cadence,
// never hardcoded. These tests pin the pure computation: cadence stats, the
// 3x-median budget rule, and the refusal to suggest a budget for a family with
// fewer than 3 samples (insufficient-samples, never a fabricated number).
import { describe, expect, it } from 'vitest';
import {
  MIN_SAMPLES_FOR_BUDGET,
  BUDGET_MEDIAN_MULTIPLIER,
  FRESHNESS_BASELINE_SCHEMA_VERSION,
  collectTimestamps,
  computeFamilyCadence,
  buildFreshnessBaseline,
  familyForFile,
} from '../scripts/measure-freshness-baseline.js';

const iso = (secondsFromEpoch: number) => new Date(secondsFromEpoch * 1000).toISOString();

describe('collectTimestamps — finds capture timestamps in real artifact shapes', () => {
  it('picks up collectedAt / capturedAt / observedAt fields at any depth', () => {
    const found = collectTimestamps({
      collectedAt: '2026-08-16T15:32:44.289Z',
      nested: { payload: { capturedAt: '2026-08-11T14:55:13.995Z' } },
      list: [{ observedAt: '2026-08-12T00:00:00.000Z' }],
    });
    expect([...found].sort()).toEqual([
      '2026-08-11T14:55:13.995Z',
      '2026-08-12T00:00:00.000Z',
      '2026-08-16T15:32:44.289Z',
    ]);
  });

  it('ignores non-timestamp-like values instead of guessing', () => {
    expect(collectTimestamps({ collectedAt: 'not-a-date', capturedAt: 42, other: '2026-08-11T14:55:13.995Z' })).toEqual([]);
  });
});

describe('familyForFile — run-ledger files group into ONE family', () => {
  it('strips the <epoch>_<suffix> run id from ledger filenames', () => {
    // Real artifacts under data/evidence/change-runs: the family name itself
    // contains underscores, so per-file families would make every run a family
    // of one and every budget null.
    expect(familyForFile('data/evidence/change-runs/console_capture_1786460113994_c05c03.jsonl')).toBe('console_capture');
    expect(familyForFile('data/evidence/change-runs/hci_apply_1785508196609_d3abb4.jsonl')).toBe('hci_apply');
    expect(familyForFile('data/evidence/change-runs/hci_delete_1786334535086_08c019.jsonl')).toBe('hci_delete');
  });

  it('falls back to the basename for standalone reports', () => {
    expect(familyForFile('data/sources/hci-scp-api-cli-report.json')).toBe('hci-scp-api-cli-report');
  });
});

describe('computeFamilyCadence — measured cadence only', () => {
  it('computes count, median and p95 of inter-capture intervals from sorted uniques', () => {
    // intervals: 10, 20, 30, 40 seconds
    const stats = computeFamilyCadence([iso(0), iso(10), iso(30), iso(60), iso(100)]);
    expect(stats.sampleCount).toBe(5);
    expect(stats.intervalCount).toBe(4);
    expect(stats.medianIntervalSec).toBe(25); // mean of 20 and 30
    expect(stats.p95IntervalSec).toBe(40);
    expect(stats.firstCapturedAt).toBe(iso(0));
    expect(stats.lastCapturedAt).toBe(iso(100));
  });

  it('de-duplicates identical timestamps before measuring cadence', () => {
    const stats = computeFamilyCadence([iso(0), iso(0), iso(10), iso(20)]);
    expect(stats.sampleCount).toBe(3);
    expect(stats.intervalCount).toBe(2);
    expect(stats.medianIntervalSec).toBe(10);
  });

  it('suggests 3x the median as the maxAgeSec budget once enough samples exist', () => {
    const stats = computeFamilyCadence([iso(0), iso(10), iso(20)]);
    expect(MIN_SAMPLES_FOR_BUDGET).toBe(3);
    expect(BUDGET_MEDIAN_MULTIPLIER).toBe(3);
    expect(stats.suggestedMaxAgeSec).toBe(30);
    expect(stats.reason).toBeNull();
  });

  it('REFUSES a budget below the sample floor (null + insufficient-samples)', () => {
    for (const few of [[], [iso(0)], [iso(0), iso(10)]]) {
      const stats = computeFamilyCadence(few);
      expect(stats.suggestedMaxAgeSec).toBeNull();
      expect(stats.reason).toBe('insufficient-samples');
    }
  });

  it('refuses a budget when every capture shares one instant (no measurable cadence)', () => {
    const stats = computeFamilyCadence([iso(5), iso(5), iso(5), iso(5)]);
    expect(stats.suggestedMaxAgeSec).toBeNull();
    expect(stats.reason).toBe('insufficient-samples');
  });
});

describe('buildFreshnessBaseline — honest artifact', () => {
  const inputs = [
    { family: 'busy', file: 'a.jsonl', timestamps: [iso(0), iso(10), iso(20), iso(30)] },
    { family: 'sparse', file: 'b.json', timestamps: [iso(0)] },
  ];

  it('emits schemaVersion, generatedAt and one entry per family', () => {
    const baseline = buildFreshnessBaseline(inputs, { generatedAt: iso(1000) });
    expect(baseline.schemaVersion).toBe(FRESHNESS_BASELINE_SCHEMA_VERSION);
    expect(baseline.generatedAt).toBe(iso(1000));
    expect(Object.keys(baseline.families).sort()).toEqual(['busy', 'sparse']);
    expect(baseline.families.busy.suggestedMaxAgeSec).toBe(30);
    expect(baseline.families.sparse.suggestedMaxAgeSec).toBeNull();
    expect(baseline.families.sparse.reason).toBe('insufficient-samples');
  });

  it('records inputs with per-family file counts (auditable provenance of the numbers)', () => {
    const baseline = buildFreshnessBaseline(inputs, { generatedAt: iso(1000) });
    expect(baseline.inputs.fileCount).toBe(2);
    expect(baseline.inputs.timestampCount).toBe(5);
    expect(baseline.inputs.byFamily.busy.fileCount).toBe(1);
    expect(baseline.inputs.byFamily.busy.timestampCount).toBe(4);
    expect(baseline.inputs.byFamily.sparse.fileCount).toBe(1);
  });

  it('never fabricates a family that produced no timestamps', () => {
    const baseline = buildFreshnessBaseline(
      [{ family: 'empty', file: 'c.json', timestamps: [] }],
      { generatedAt: iso(1000) },
    );
    expect(baseline.families.empty.suggestedMaxAgeSec).toBeNull();
    expect(baseline.families.empty.reason).toBe('insufficient-samples');
    expect(baseline.families.empty.sampleCount).toBe(0);
  });
});
