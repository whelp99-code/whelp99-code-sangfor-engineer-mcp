/**
 * Time-saved ledger (design 002, block E3).
 *
 * Every auto-closed finding, assembled dossier and generated report records the
 * minutes it saved a human, so `@sangfor/competency`'s replacement rate can be
 * argued from a ledger instead of a slide.
 *
 * The number never comes from the caller's imagination: `basis` must name an
 * entry in the injected basis table (a measured ticket sample, a time study),
 * and `estimateMinutes` must equal what that table says for the kind. A missing
 * or unknown basis, or a number that disagrees with its basis, is rejected and
 * nothing is written — an unsourced estimate is worse than no metric at all.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendJsonl, nowId } from '@sangfor/shared';
import { parseBoundaryTimeSavedLineV1 } from './runtime-boundaries.js';

export type TimeSavedKind = 'auto-closed-finding' | 'dossier-assembled' | 'report-generated';

export const TIME_SAVED_KINDS: readonly TimeSavedKind[] = [
  'auto-closed-finding',
  'dossier-assembled',
  'report-generated',
];

/** basisId → minutes saved per kind, as measured. */
export type TimeSavedBasisTable = Record<string, Record<TimeSavedKind, number>>;

export interface RecordTimeSavedInput {
  kind: TimeSavedKind;
  findingId?: string;
  estimateMinutes: number;
  /** Id of the measured basis this estimate comes from. */
  basis: string;
  at: string;
}

export interface TimeSavedEntry {
  id: string;
  kind: TimeSavedKind;
  findingId?: string;
  estimateMinutes: number;
  basis: string;
  at: string;
}

export interface TimeSavedWindow {
  from: string;
  to: string;
}

export interface TimeSavedKindTotal {
  entries: number;
  minutes: number;
}

export interface TimeSavedSummary extends TimeSavedWindow {
  entries: number;
  totalMinutes: number;
  byKind: Record<TimeSavedKind, TimeSavedKindTotal>;
}

const LEDGER_FILE = 'time-saved.jsonl';

/**
 * Validate against the injected basis table and append one ledger entry.
 * Throws — writing nothing — when the estimate is not sourced.
 */
export function recordTimeSaved(
  ledgerDir: string,
  input: RecordTimeSavedInput,
  basisTable: TimeSavedBasisTable,
): TimeSavedEntry {
  if (input.basis.trim() === '') {
    throw new Error('recordTimeSaved: basis is required — an estimate without a measured basis is not a metric');
  }
  const basisRow = basisTable[input.basis];
  if (!basisRow) {
    throw new Error(`recordTimeSaved: unknown basis "${input.basis}" — it must name an entry in the injected basis table`);
  }
  const expected = basisRow[input.kind];
  if (typeof expected !== 'number') {
    throw new Error(`recordTimeSaved: basis "${input.basis}" has no measured value for kind "${input.kind}"`);
  }
  if (input.estimateMinutes !== expected) {
    throw new Error(
      `recordTimeSaved: estimateMinutes ${input.estimateMinutes} disagrees with basis "${input.basis}" (${expected}) for kind "${input.kind}"`,
    );
  }

  const entry: TimeSavedEntry = {
    id: nowId('timesaved'),
    kind: input.kind,
    ...(input.findingId === undefined ? {} : { findingId: input.findingId }),
    estimateMinutes: input.estimateMinutes,
    basis: input.basis,
    at: input.at,
  };
  appendJsonl(join(ledgerDir, LEDGER_FILE), entry);
  return entry;
}

function readLedger(ledgerDir: string): TimeSavedEntry[] {
  let raw: string;
  try {
    raw = readFileSync(join(ledgerDir, LEDGER_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const entries: TimeSavedEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    entries.push(parseBoundaryTimeSavedLineV1(trimmed));
  }
  return entries;
}

/** Total saved minutes per kind inside an inclusive [from, to] window. */
export function summarizeTimeSaved(ledgerDir: string, window: TimeSavedWindow): TimeSavedSummary {
  const byKind = Object.fromEntries(
    TIME_SAVED_KINDS.map((kind) => [kind, { entries: 0, minutes: 0 }]),
  ) as Record<TimeSavedKind, TimeSavedKindTotal>;

  let entries = 0;
  let totalMinutes = 0;
  for (const entry of readLedger(ledgerDir)) {
    if (entry.at < window.from || entry.at > window.to) continue;
    const bucket = byKind[entry.kind];
    if (!bucket) continue;
    bucket.entries += 1;
    bucket.minutes += entry.estimateMinutes;
    entries += 1;
    totalMinutes += entry.estimateMinutes;
  }

  return { from: window.from, to: window.to, entries, totalMinutes, byKind };
}
