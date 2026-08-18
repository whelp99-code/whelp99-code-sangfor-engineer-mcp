/**
 * Steady-state envelope learning (design 002, block B2).
 *
 * Observed metrics are bucketed by hour-of-week (UTC) and reduced to a quantile
 * band per bucket, so "normal" is allowed to differ between Tuesday 03:00 and
 * Monday 09:00 instead of being flattened into one static threshold. Samples
 * captured inside a declared incident window never train a band — otherwise an
 * outage teaches the baseline that the outage was normal. A bucket that has not
 * met the caller's minimum sample count reports `insufficient-data` rather than
 * a band interpolated from too little evidence; the caller falls back to its
 * static thresholds.
 */

export interface EnvelopeSample {
  at: string;
  value: number;
}

export interface ExcludeWindow {
  startAt: string;
  endAt: string;
}

export interface LearnEnvelopeOptions {
  /** Below this count a bucket carries no band. Injected — no hidden default. */
  minSamplesPerBucket: number;
  /** [lower, upper] in [0,1], lower <= upper. Defaults to p05/p95. */
  quantiles?: [number, number];
  /** Incident (or maintenance) windows whose samples must not train a band. */
  excludeWindows?: readonly ExcludeWindow[];
}

export interface EnvelopeBucket {
  hourOfWeek: number;
  sampleCount: number;
  /** Absent when sampleCount < minSamplesPerBucket. */
  lower?: number;
  upper?: number;
}

export interface Envelope {
  quantiles: [number, number];
  minSamplesPerBucket: number;
  /** Keyed by hour-of-week 0..167, Sunday 00:00 UTC = 0. */
  buckets: Record<number, EnvelopeBucket>;
}

export type EnvelopeVerdict =
  | { verdict: 'within' | 'outside'; hourOfWeek: number; lower: number; upper: number; value: number }
  | { verdict: 'insufficient-data'; hourOfWeek: number; sampleCount: number; minSamplesPerBucket: number };

const DEFAULT_QUANTILES: [number, number] = [0.05, 0.95];

function toEpoch(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`Invalid timestamp "${iso}"`);
  return ms;
}

/** UTC hour-of-week: Sunday 00:00 is 0, Saturday 23:00 is 167. */
export function hourOfWeek(iso: string): number {
  const date = new Date(toEpoch(iso));
  return date.getUTCDay() * 24 + date.getUTCHours();
}

/** Linear-interpolation quantile over an ascending sample array. */
function quantile(sorted: readonly number[], q: number): number {
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  const lowValue = sorted[low] as number;
  if (low === high) return lowValue;
  return lowValue + ((sorted[high] as number) - lowValue) * (position - low);
}

function isExcluded(atMs: number, windows: readonly ExcludeWindow[]): boolean {
  // Bounds are inclusive: an incident declared to the second must not leak its
  // edge samples into the baseline.
  return windows.some((w) => atMs >= toEpoch(w.startAt) && atMs <= toEpoch(w.endAt));
}

export function learnEnvelope(
  samples: readonly EnvelopeSample[],
  opts: LearnEnvelopeOptions,
): Envelope {
  const quantiles = opts.quantiles ?? DEFAULT_QUANTILES;
  if (!Number.isInteger(opts.minSamplesPerBucket) || opts.minSamplesPerBucket < 1) {
    throw new Error(`Invalid minSamplesPerBucket ${opts.minSamplesPerBucket}: must be >= 1`);
  }
  const [lowerQ, upperQ] = quantiles;
  if (!(lowerQ >= 0 && upperQ <= 1 && lowerQ <= upperQ)) {
    throw new Error(`Invalid quantiles [${lowerQ}, ${upperQ}]: need 0 <= lower <= upper <= 1`);
  }
  const excludeWindows = opts.excludeWindows ?? [];

  const byBucket = new Map<number, number[]>();
  for (const sample of samples) {
    const atMs = toEpoch(sample.at);
    if (isExcluded(atMs, excludeWindows)) continue;
    const bucket = hourOfWeek(sample.at);
    const values = byBucket.get(bucket);
    if (values) values.push(sample.value);
    else byBucket.set(bucket, [sample.value]);
  }

  const buckets: Record<number, EnvelopeBucket> = {};
  for (const bucket of [...byBucket.keys()].sort((a, b) => a - b)) {
    const values = (byBucket.get(bucket) as number[]).slice().sort((a, b) => a - b);
    if (values.length < opts.minSamplesPerBucket) {
      buckets[bucket] = { hourOfWeek: bucket, sampleCount: values.length };
      continue;
    }
    buckets[bucket] = {
      hourOfWeek: bucket,
      sampleCount: values.length,
      lower: quantile(values, lowerQ),
      upper: quantile(values, upperQ),
    };
  }

  return { quantiles, minSamplesPerBucket: opts.minSamplesPerBucket, buckets };
}

/** Band membership is inclusive of both bounds. */
export function isWithinEnvelope(envelope: Envelope, at: string, value: number): EnvelopeVerdict {
  const bucketKey = hourOfWeek(at);
  const bucket = envelope.buckets[bucketKey];
  if (!bucket || bucket.lower === undefined || bucket.upper === undefined) {
    return {
      verdict: 'insufficient-data',
      hourOfWeek: bucketKey,
      sampleCount: bucket?.sampleCount ?? 0,
      minSamplesPerBucket: envelope.minSamplesPerBucket,
    };
  }
  return {
    verdict: value >= bucket.lower && value <= bucket.upper ? 'within' : 'outside',
    hourOfWeek: bucketKey,
    lower: bucket.lower,
    upper: bucket.upper,
    value,
  };
}
