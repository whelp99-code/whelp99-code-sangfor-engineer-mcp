import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  recordTimeSaved,
  summarizeTimeSaved,
  type TimeSavedBasisTable,
} from '../packages/sangfor-scorecard/src/index.js';

const basisTable: TimeSavedBasisTable = {
  'ticket-sample-2026Q2': {
    'auto-closed-finding': 12,
    'dossier-assembled': 35,
    'report-generated': 90,
  },
};

describe('@sangfor/scorecard — time-saved ledger (design 002, block E3)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'scorecard-time-saved-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function record(kind: 'auto-closed-finding' | 'dossier-assembled' | 'report-generated', at: string, findingId?: string) {
    return recordTimeSaved(dir, {
      kind,
      findingId,
      estimateMinutes: basisTable['ticket-sample-2026Q2'][kind],
      basis: 'ticket-sample-2026Q2',
      at,
    }, basisTable);
  }

  it('appends a ledger entry carrying the estimate and its basis', () => {
    const entry = record('auto-closed-finding', '2026-08-01T10:00:00.000Z', 'f-1');

    const lines = readFileSync(join(dir, 'time-saved.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({
      id: entry.id,
      kind: 'auto-closed-finding',
      findingId: 'f-1',
      estimateMinutes: 12,
      basis: 'ticket-sample-2026Q2',
      at: '2026-08-01T10:00:00.000Z',
    });
  });

  it('omits findingId entirely for entries that are not finding-scoped', () => {
    record('report-generated', '2026-08-01T11:00:00.000Z');
    const parsed = JSON.parse(readFileSync(join(dir, 'time-saved.jsonl'), 'utf8').trim());
    expect('findingId' in parsed).toBe(false);
  });

  it('rejects an estimate with no basis string — an unsourced number is not a metric', () => {
    expect(() =>
      recordTimeSaved(dir, {
        kind: 'auto-closed-finding',
        estimateMinutes: 12,
        basis: '',
        at: '2026-08-01T10:00:00.000Z',
      }, basisTable),
    ).toThrow(/basis/i);
    expect(() =>
      recordTimeSaved(dir, {
        kind: 'auto-closed-finding',
        estimateMinutes: 12,
        basis: '   ',
        at: '2026-08-01T10:00:00.000Z',
      }, basisTable),
    ).toThrow(/basis/i);
  });

  it('rejects a basis that is not in the injected table', () => {
    expect(() =>
      recordTimeSaved(dir, {
        kind: 'auto-closed-finding',
        estimateMinutes: 12,
        basis: 'gut-feeling',
        at: '2026-08-01T10:00:00.000Z',
      }, basisTable),
    ).toThrow(/gut-feeling/);
  });

  it('rejects an estimate that disagrees with the basis table — the table owns the number', () => {
    expect(() =>
      recordTimeSaved(dir, {
        kind: 'auto-closed-finding',
        estimateMinutes: 600,
        basis: 'ticket-sample-2026Q2',
        at: '2026-08-01T10:00:00.000Z',
      }, basisTable),
    ).toThrow(/600/);
  });

  it('writes nothing to the ledger when a record is rejected', () => {
    expect(() =>
      recordTimeSaved(dir, {
        kind: 'auto-closed-finding',
        estimateMinutes: 12,
        basis: 'gut-feeling',
        at: '2026-08-01T10:00:00.000Z',
      }, basisTable),
    ).toThrow();
    expect(() => readFileSync(join(dir, 'time-saved.jsonl'), 'utf8')).toThrow();
  });

  it('summarizes totals per kind inside the window', () => {
    record('auto-closed-finding', '2026-08-01T10:00:00.000Z', 'f-1');
    record('auto-closed-finding', '2026-08-02T10:00:00.000Z', 'f-2');
    record('dossier-assembled', '2026-08-03T10:00:00.000Z', 'f-3');
    record('report-generated', '2026-08-04T10:00:00.000Z');

    expect(summarizeTimeSaved(dir, { from: '2026-08-01T00:00:00.000Z', to: '2026-08-30T00:00:00.000Z' })).toEqual({
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-30T00:00:00.000Z',
      entries: 4,
      totalMinutes: 12 + 12 + 35 + 90,
      byKind: {
        'auto-closed-finding': { entries: 2, minutes: 24 },
        'dossier-assembled': { entries: 1, minutes: 35 },
        'report-generated': { entries: 1, minutes: 90 },
      },
    });
  });

  it('excludes entries outside the window and treats both bounds as inclusive', () => {
    record('auto-closed-finding', '2026-07-31T23:59:59.000Z', 'f-early');
    record('auto-closed-finding', '2026-08-01T00:00:00.000Z', 'f-from');
    record('dossier-assembled', '2026-08-30T00:00:00.000Z', 'f-to');
    record('report-generated', '2026-08-30T00:00:01.000Z');

    const summary = summarizeTimeSaved(dir, { from: '2026-08-01T00:00:00.000Z', to: '2026-08-30T00:00:00.000Z' });
    expect(summary.entries).toBe(2);
    expect(summary.totalMinutes).toBe(12 + 35);
    expect(summary.byKind).toEqual({
      'auto-closed-finding': { entries: 1, minutes: 12 },
      'dossier-assembled': { entries: 1, minutes: 35 },
      'report-generated': { entries: 0, minutes: 0 },
    });
  });

  it('reports an empty ledger as zeros for every kind', () => {
    expect(summarizeTimeSaved(dir, { from: '2026-08-01T00:00:00.000Z', to: '2026-08-30T00:00:00.000Z' })).toEqual({
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-30T00:00:00.000Z',
      entries: 0,
      totalMinutes: 0,
      byKind: {
        'auto-closed-finding': { entries: 0, minutes: 0 },
        'dossier-assembled': { entries: 0, minutes: 0 },
        'report-generated': { entries: 0, minutes: 0 },
      },
    });
  });
});
