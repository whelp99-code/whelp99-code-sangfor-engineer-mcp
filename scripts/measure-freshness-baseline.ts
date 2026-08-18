/**
 * A1 (Step 7) — measured freshness baseline.
 *
 * Scans the repo's REAL local capture artifacts for capture timestamps, groups
 * them by source family, measures the inter-capture cadence, and derives a
 * per-family `maxAgeSec` budget as BUDGET_MEDIAN_MULTIPLIER x median interval.
 *
 * Honesty rule (the whole point of this step): a budget is emitted ONLY where at
 * least MIN_SAMPLES_FOR_BUDGET distinct capture instants were actually observed.
 * Families below the floor are emitted as
 *   { suggestedMaxAgeSec: null, reason: 'insufficient-samples' }
 * — inventing a number for a family we never measured would be a fabrication.
 *
 * Usage: pnpm exec tsx scripts/measure-freshness-baseline.ts
 * Output: data/evals/observability-phase1/freshness-baseline.json
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const FRESHNESS_BASELINE_SCHEMA_VERSION = 1;
/** Distinct capture instants required before any budget may be suggested. */
export const MIN_SAMPLES_FOR_BUDGET = 3;
/** Budget = this multiple of the measured median inter-capture interval. */
export const BUDGET_MEDIAN_MULTIPLIER = 3;

const OUTPUT_PATH = 'data/evals/observability-phase1/freshness-baseline.json';

/** Field names that carry a capture instant in this repo's artifacts. */
const TIMESTAMP_FIELDS = new Set(['collectedAt', 'capturedAt', 'observedAt', 'collected_at', 'captured_at']);

const ISO_LIKE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && ISO_LIKE.test(value) && !Number.isNaN(Date.parse(value));
}

/** Walk any parsed JSON value and collect every capture timestamp it carries. */
export function collectTimestamps(node: unknown): string[] {
  const found: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (TIMESTAMP_FIELDS.has(key) && isTimestamp(child)) found.push(child);
      else visit(child);
    }
  };
  visit(node);
  return found;
}

export interface FamilyCadence {
  sampleCount: number;
  intervalCount: number;
  medianIntervalSec: number | null;
  p95IntervalSec: number | null;
  minIntervalSec: number | null;
  maxIntervalSec: number | null;
  firstCapturedAt: string | null;
  lastCapturedAt: string | null;
  suggestedMaxAgeSec: number | null;
  reason: 'insufficient-samples' | null;
}

/** Nearest-rank quantile (ceiling): with few samples this reports the observed
 *  tail rather than rounding it down into a friendlier number. */
function quantile(sortedAsc: number[], q: number): number {
  const rank = Math.max(1, Math.ceil(q * sortedAsc.length));
  return sortedAsc[rank - 1]!;
}

function median(sortedAsc: number[]): number {
  const mid = Math.floor(sortedAsc.length / 2);
  return sortedAsc.length % 2 === 0 ? (sortedAsc[mid - 1]! + sortedAsc[mid]!) / 2 : sortedAsc[mid]!;
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Measure cadence for one family. Distinct instants only — repeated writes of the
 *  same instant are one observation, not a zero-second collection cycle. */
export function computeFamilyCadence(timestamps: readonly string[]): FamilyCadence {
  const epochs = [...new Set(timestamps.filter(isTimestamp).map((t) => Date.parse(t)))].sort((a, b) => a - b);
  const insufficient: FamilyCadence = {
    sampleCount: epochs.length,
    intervalCount: Math.max(epochs.length - 1, 0),
    medianIntervalSec: null,
    p95IntervalSec: null,
    minIntervalSec: null,
    maxIntervalSec: null,
    firstCapturedAt: epochs.length ? new Date(epochs[0]!).toISOString() : null,
    lastCapturedAt: epochs.length ? new Date(epochs[epochs.length - 1]!).toISOString() : null,
    suggestedMaxAgeSec: null,
    reason: 'insufficient-samples',
  };
  if (epochs.length < MIN_SAMPLES_FOR_BUDGET) return insufficient;

  const intervals: number[] = [];
  for (let i = 1; i < epochs.length; i += 1) intervals.push((epochs[i]! - epochs[i - 1]!) / 1000);
  intervals.sort((a, b) => a - b);
  const med = median(intervals);

  return {
    sampleCount: epochs.length,
    intervalCount: intervals.length,
    medianIntervalSec: round3(med),
    p95IntervalSec: round3(quantile(intervals, 0.95)),
    minIntervalSec: round3(intervals[0]!),
    maxIntervalSec: round3(intervals[intervals.length - 1]!),
    firstCapturedAt: insufficient.firstCapturedAt,
    lastCapturedAt: insufficient.lastCapturedAt,
    suggestedMaxAgeSec: round3(med * BUDGET_MEDIAN_MULTIPLIER),
    reason: null,
  };
}

export interface FamilyInput { family: string; file: string; timestamps: string[] }

export interface FreshnessBaseline {
  schemaVersion: number;
  generatedAt: string;
  families: Record<string, FamilyCadence>;
  inputs: {
    fileCount: number;
    timestampCount: number;
    byFamily: Record<string, { fileCount: number; timestampCount: number; files: string[] }>;
  };
}

export function buildFreshnessBaseline(
  inputs: readonly FamilyInput[],
  opts: { generatedAt?: string } = {},
): FreshnessBaseline {
  const byFamily: Record<string, { fileCount: number; timestampCount: number; files: string[] }> = {};
  const timestampsByFamily = new Map<string, string[]>();

  for (const input of inputs) {
    const bucket = timestampsByFamily.get(input.family) ?? [];
    bucket.push(...input.timestamps);
    timestampsByFamily.set(input.family, bucket);
    const meta = byFamily[input.family] ?? { fileCount: 0, timestampCount: 0, files: [] };
    meta.fileCount += 1;
    meta.timestampCount += input.timestamps.length;
    meta.files.push(input.file);
    byFamily[input.family] = meta;
  }

  const families: Record<string, FamilyCadence> = {};
  for (const [family, timestamps] of [...timestampsByFamily.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    families[family] = computeFamilyCadence(timestamps);
  }

  return {
    schemaVersion: FRESHNESS_BASELINE_SCHEMA_VERSION,
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    families,
    inputs: {
      fileCount: inputs.length,
      timestampCount: inputs.reduce((sum, i) => sum + i.timestamps.length, 0),
      byFamily,
    },
  };
}

// ---------------------------------------------------------------------------
// Scanning the real artifacts (impure edge; the computation above stays pure).
// ---------------------------------------------------------------------------

/** Roots scanned for capture artifacts, in repo-relative form. */
export const SCAN_ROOTS = ['data/captures', 'data/evidence', 'data/sources/hci-scp-api-cli-report.json'];

function* walkFiles(path: string): Generator<string> {
  if (!existsSync(path)) return;
  if (statSync(path).isFile()) {
    yield path;
    return;
  }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) yield* walkFiles(child);
    else if (entry.isFile()) yield child;
  }
}

/** Family = the artifact's source family, derived from its filename/location:
 *  run-ledger files are `<kind>_<epoch>_<suffix>.jsonl`, standalone reports use
 *  their basename. Product-tagged capture events are split per product. */
export function familyForFile(path: string): string {
  const base = path.split('/').pop() ?? path;
  const runMatch = /^(.+?)_\d{10,}_[a-z0-9]+\.jsonl$/i.exec(base);
  if (runMatch) return runMatch[1]!;
  return base.replace(/\.(json|jsonl)$/i, '');
}

function parseArtifact(path: string): unknown[] {
  const text = readFileSync(path, 'utf8');
  if (path.endsWith('.jsonl')) {
    const records: unknown[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { records.push(JSON.parse(line)); } catch { /* a truncated ledger line is not a capture */ }
    }
    return records;
  }
  try { return [JSON.parse(text)]; } catch { return []; }
}

/** Refine a run-ledger family with the product the event was captured from, when
 *  the payload states it (e.g. console_capture → console_capture:HCI). */
function familyForRecord(fileFamily: string, record: unknown): string {
  const product = (record as { payload?: { product?: unknown } } | null)?.payload?.product;
  return typeof product === 'string' && product.length > 0 ? `${fileFamily}:${product}` : fileFamily;
}

export function scanCaptureInputs(roots: readonly string[] = SCAN_ROOTS): FamilyInput[] {
  const inputs: FamilyInput[] = [];
  for (const root of roots) {
    for (const file of walkFiles(root)) {
      if (!/\.(json|jsonl)$/i.test(file)) continue;
      const fileFamily = familyForFile(file);
      const perFamily = new Map<string, string[]>();
      for (const record of parseArtifact(file)) {
        const timestamps = collectTimestamps(record);
        if (timestamps.length === 0) continue;
        const family = familyForRecord(fileFamily, record);
        const bucket = perFamily.get(family) ?? [];
        bucket.push(...timestamps);
        perFamily.set(family, bucket);
      }
      for (const [family, timestamps] of perFamily) inputs.push({ family, file, timestamps });
    }
  }
  return inputs.sort((a, b) => (a.family === b.family ? a.file.localeCompare(b.file) : a.family.localeCompare(b.family)));
}

function main(): void {
  const inputs = scanCaptureInputs();
  const baseline = buildFreshnessBaseline(inputs);
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');

  const lines = [`freshness baseline → ${OUTPUT_PATH}`,
    `scanned ${baseline.inputs.fileCount} artifact file(s), ${baseline.inputs.timestampCount} capture timestamp(s)`];
  for (const [family, stats] of Object.entries(baseline.families)) {
    lines.push(stats.suggestedMaxAgeSec === null
      ? `  ${family}: samples=${stats.sampleCount} → suggestedMaxAgeSec=null (${stats.reason})`
      : `  ${family}: samples=${stats.sampleCount} median=${stats.medianIntervalSec}s p95=${stats.p95IntervalSec}s → suggestedMaxAgeSec=${stats.suggestedMaxAgeSec}s`);
  }
  process.stderr.write(`${lines.join('\n')}\n`);
}

const invokedDirectly = process.argv[1] !== undefined && process.argv[1].endsWith('measure-freshness-baseline.ts');
if (invokedDirectly) main();
