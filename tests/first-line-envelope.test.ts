import { describe, expect, it } from 'vitest';
import {
  isWithinEnvelope,
  learnEnvelope,
  type EnvelopeSample,
} from '../packages/sangfor-first-line/src/index.js';

/**
 * Design 002, block B2 — steady-state envelope learning.
 *
 * The bands are hour-of-week quantiles, incident windows never train the
 * baseline, and a bucket that has not seen enough samples says so instead of
 * inventing a band the caller would trust.
 */

/** 2026-08-03 is a Monday; UTC hour-of-week 0 is Sunday 00:00. */
const MONDAY_09 = '2026-08-03T09:00:00.000Z';
const MONDAY_09_HOW = 1 * 24 + 9;

function samplesAt(at: string, values: readonly number[]): EnvelopeSample[] {
  // Same hour bucket, distinct minutes, so ordering never depends on ties.
  return values.map((value, index) => ({
    at: at.replace('00:00.000Z', `${String(index).padStart(2, '0')}:00.000Z`),
    value,
  }));
}

describe('@sangfor/first-line — learnEnvelope (B2)', () => {
  it('learns one quantile band per hour-of-week bucket', () => {
    const envelope = learnEnvelope(samplesAt(MONDAY_09, [10, 20, 30, 40, 50]), {
      minSamplesPerBucket: 5,
      quantiles: [0.1, 0.9],
    });

    expect(envelope.quantiles).toEqual([0.1, 0.9]);
    expect(envelope.minSamplesPerBucket).toBe(5);
    expect(Object.keys(envelope.buckets)).toEqual([String(MONDAY_09_HOW)]);

    const bucket = envelope.buckets[MONDAY_09_HOW];
    expect(bucket).toEqual({
      hourOfWeek: MONDAY_09_HOW,
      sampleCount: 5,
      lower: 14,
      upper: 46,
    });
  });

  it('keeps buckets independent — a Tuesday hour never borrows Monday samples', () => {
    const envelope = learnEnvelope(
      [
        ...samplesAt(MONDAY_09, [10, 10, 10, 10, 10]),
        ...samplesAt('2026-08-04T09:00:00.000Z', [90, 90, 90, 90, 90]),
      ],
      { minSamplesPerBucket: 5, quantiles: [0, 1] },
    );

    expect(envelope.buckets[MONDAY_09_HOW]?.upper).toBe(10);
    expect(envelope.buckets[2 * 24 + 9]?.lower).toBe(90);
  });

  it('never trains the baseline on samples inside an excluded incident window', () => {
    const clean = samplesAt(MONDAY_09, [10, 12, 14, 16, 18]);
    const duringIncident = samplesAt('2026-08-10T09:00:00.000Z', [900, 950, 990, 999, 1000]);

    const envelope = learnEnvelope([...clean, ...duringIncident], {
      minSamplesPerBucket: 5,
      quantiles: [0, 1],
      excludeWindows: [{ startAt: '2026-08-10T08:00:00.000Z', endAt: '2026-08-10T10:00:00.000Z' }],
    });

    // Both sample sets land in the same hour-of-week bucket; only the clean run trained it.
    expect(envelope.buckets[MONDAY_09_HOW]).toEqual({
      hourOfWeek: MONDAY_09_HOW,
      sampleCount: 5,
      lower: 10,
      upper: 18,
    });
  });

  it('treats exclusion-window bounds as inclusive', () => {
    const envelope = learnEnvelope(
      [
        { at: '2026-08-03T09:00:00.000Z', value: 1000 },
        { at: '2026-08-03T09:30:00.000Z', value: 5 },
        { at: '2026-08-03T10:00:00.000Z', value: 2000 },
      ],
      {
        minSamplesPerBucket: 1,
        quantiles: [0, 1],
        excludeWindows: [
          { startAt: '2026-08-03T09:00:00.000Z', endAt: '2026-08-03T09:00:00.000Z' },
          { startAt: '2026-08-03T10:00:00.000Z', endAt: '2026-08-03T10:00:00.000Z' },
        ],
      },
    );

    expect(envelope.buckets[MONDAY_09_HOW]?.sampleCount).toBe(1);
    expect(envelope.buckets[1 * 24 + 10]).toBeUndefined();
    expect(envelope.buckets[MONDAY_09_HOW]?.lower).toBe(5);
  });

  it('records a thin bucket without a band instead of fabricating one', () => {
    const envelope = learnEnvelope(samplesAt(MONDAY_09, [10, 20, 30]), {
      minSamplesPerBucket: 5,
      quantiles: [0, 1],
    });

    const bucket = envelope.buckets[MONDAY_09_HOW];
    expect(bucket).toEqual({ hourOfWeek: MONDAY_09_HOW, sampleCount: 3 });
    expect(bucket).not.toHaveProperty('lower');
    expect(bucket).not.toHaveProperty('upper');
  });

  it('rejects an unusable configuration rather than guessing', () => {
    expect(() => learnEnvelope([], { minSamplesPerBucket: 0 })).toThrow(/minSamplesPerBucket/u);
    expect(() => learnEnvelope([], { minSamplesPerBucket: 5, quantiles: [0.9, 0.1] })).toThrow(
      /quantiles/u,
    );
    expect(() =>
      learnEnvelope([{ at: 'not-a-date', value: 1 }], { minSamplesPerBucket: 1 }),
    ).toThrow(/not-a-date/u);
  });
});

describe('@sangfor/first-line — isWithinEnvelope (B2)', () => {
  const envelope = learnEnvelope(samplesAt(MONDAY_09, [10, 20, 30, 40, 50]), {
    minSamplesPerBucket: 5,
    quantiles: [0, 1],
  });

  it('accepts a value inside the learned band, bounds inclusive', () => {
    expect(isWithinEnvelope(envelope, MONDAY_09, 30)).toEqual({
      verdict: 'within',
      hourOfWeek: MONDAY_09_HOW,
      lower: 10,
      upper: 50,
      value: 30,
    });
    expect(isWithinEnvelope(envelope, MONDAY_09, 10).verdict).toBe('within');
    expect(isWithinEnvelope(envelope, MONDAY_09, 50).verdict).toBe('within');
  });

  it('flags a value outside the learned band', () => {
    expect(isWithinEnvelope(envelope, MONDAY_09, 51)).toEqual({
      verdict: 'outside',
      hourOfWeek: MONDAY_09_HOW,
      lower: 10,
      upper: 50,
      value: 51,
    });
    expect(isWithinEnvelope(envelope, MONDAY_09, 9).verdict).toBe('outside');
  });

  it('reports insufficient-data for an untrained bucket so the caller falls back to static thresholds', () => {
    const result = isWithinEnvelope(envelope, '2026-08-04T09:00:00.000Z', 30);

    expect(result).toEqual({
      verdict: 'insufficient-data',
      hourOfWeek: 2 * 24 + 9,
      sampleCount: 0,
      minSamplesPerBucket: 5,
    });
    // No fabricated band ever leaks out of a cold-start bucket.
    expect(result).not.toHaveProperty('lower');
    expect(result).not.toHaveProperty('upper');
  });

  it('reports insufficient-data for a bucket that saw samples but too few', () => {
    const thin = learnEnvelope(samplesAt(MONDAY_09, [10, 20, 30]), { minSamplesPerBucket: 5 });
    const result = isWithinEnvelope(thin, MONDAY_09, 999);

    expect(result).toEqual({
      verdict: 'insufficient-data',
      hourOfWeek: MONDAY_09_HOW,
      sampleCount: 3,
      minSamplesPerBucket: 5,
    });
  });
});
