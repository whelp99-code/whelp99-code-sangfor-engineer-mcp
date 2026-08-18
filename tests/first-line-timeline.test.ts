import { describe, expect, it } from 'vitest';
import {
  buildTimeline,
  type BuildTimelineInput,
  type TimelineEntry,
} from '../packages/sangfor-first-line/src/index.js';

/**
 * Design 002, block B3 — change-correlated timeline read model.
 *
 * Config diffs, health events, approvals and agent findings merge into one
 * ordered read model. Every source keeps its own timestamp fields, and where a
 * device clock and the collector clock disagree the entry says so instead of
 * quietly picking a winner.
 */

const empty: BuildTimelineInput = { diffs: [], healthEvents: [], approvals: [], findings: [] };

const input: BuildTimelineInput = {
  diffs: [
    {
      deviceId: 'dev-1',
      snapshotHash: 'sha-b',
      capturedAt: '2026-08-03T09:10:00.000Z',
      keys: ['ntpServer'],
    },
  ],
  healthEvents: [
    {
      deviceId: 'dev-1',
      eventId: 'evt-1',
      severity: 'warning',
      summary: 'ntp sync lost',
      deviceReportedAt: '2026-08-03T09:05:00.000Z',
      collectorObservedAt: '2026-08-03T09:05:00.000Z',
    },
  ],
  approvals: [
    {
      deviceId: 'dev-1',
      changeTicketId: 'CHG-9',
      approvedAt: '2026-08-03T09:00:00.000Z',
    },
  ],
  findings: [
    {
      deviceId: 'dev-1',
      findingKey: 'ntp-drift',
      state: 'detected',
      detectedAt: '2026-08-03T09:15:00.000Z',
    },
  ],
};

describe('@sangfor/first-line — buildTimeline (B3)', () => {
  it('merges all four sources into one chronologically ordered read model', () => {
    const timeline = buildTimeline(input);

    expect(timeline.map((e) => [e.kind, e.at])).toEqual([
      ['approval', '2026-08-03T09:00:00.000Z'],
      ['health-event', '2026-08-03T09:05:00.000Z'],
      ['config-diff', '2026-08-03T09:10:00.000Z'],
      ['finding', '2026-08-03T09:15:00.000Z'],
    ]);
  });

  it('returns an empty timeline for empty inputs', () => {
    expect(buildTimeline(empty)).toEqual([]);
  });

  it('carries each source payload through without reshaping it', () => {
    const diffEntry = buildTimeline(input).find((e) => e.kind === 'config-diff') as TimelineEntry;

    expect(diffEntry).toMatchObject({
      kind: 'config-diff',
      deviceId: 'dev-1',
      at: '2026-08-03T09:10:00.000Z',
      orderingConfidence: 'exact',
      source: { snapshotHash: 'sha-b', keys: ['ntpServer'] },
    });
  });

  it('keeps both clocks and marks ordering skewed when they disagree', () => {
    const timeline = buildTimeline({
      ...empty,
      healthEvents: [
        {
          deviceId: 'dev-1',
          eventId: 'evt-skew',
          severity: 'critical',
          summary: 'psu failure',
          deviceReportedAt: '2026-08-03T09:00:00.000Z',
          collectorObservedAt: '2026-08-03T09:04:00.000Z',
        },
      ],
    });

    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      kind: 'health-event',
      deviceReportedAt: '2026-08-03T09:00:00.000Z',
      collectorObservedAt: '2026-08-03T09:04:00.000Z',
      orderingConfidence: 'skewed',
      skewMs: 240_000,
    });
  });

  it('marks ordering exact and omits skewMs when both clocks agree', () => {
    const [entry] = buildTimeline({ ...empty, healthEvents: input.healthEvents });

    expect(entry?.orderingConfidence).toBe('exact');
    expect(entry).not.toHaveProperty('skewMs');
    expect(entry?.deviceReportedAt).toBe('2026-08-03T09:05:00.000Z');
    expect(entry?.collectorObservedAt).toBe('2026-08-03T09:05:00.000Z');
  });

  it('never silently reorders a skewed entry: it orders by the device clock and flags the skew', () => {
    const timeline = buildTimeline({
      ...empty,
      diffs: [
        { deviceId: 'dev-1', snapshotHash: 'sha-a', capturedAt: '2026-08-03T09:02:00.000Z', keys: ['a'] },
      ],
      healthEvents: [
        {
          deviceId: 'dev-1',
          eventId: 'evt-late',
          severity: 'warning',
          summary: 'link flap',
          // The device says this happened first; the collector only saw it later.
          deviceReportedAt: '2026-08-03T09:01:00.000Z',
          collectorObservedAt: '2026-08-03T09:09:00.000Z',
        },
      ],
    });

    expect(timeline.map((e) => e.kind)).toEqual(['health-event', 'config-diff']);
    expect(timeline[0]?.orderingConfidence).toBe('skewed');
    expect(timeline[1]?.orderingConfidence).toBe('exact');
  });

  it('breaks timestamp ties deterministically by kind then id', () => {
    const at = '2026-08-03T09:00:00.000Z';
    const timeline = buildTimeline({
      diffs: [{ deviceId: 'dev-1', snapshotHash: 'sha-z', capturedAt: at, keys: [] }],
      healthEvents: [
        {
          deviceId: 'dev-1',
          eventId: 'evt-b',
          severity: 'info',
          summary: 'b',
          deviceReportedAt: at,
          collectorObservedAt: at,
        },
        {
          deviceId: 'dev-1',
          eventId: 'evt-a',
          severity: 'info',
          summary: 'a',
          deviceReportedAt: at,
          collectorObservedAt: at,
        },
      ],
      approvals: [{ deviceId: 'dev-1', changeTicketId: 'CHG-1', approvedAt: at }],
      findings: [{ deviceId: 'dev-1', findingKey: 'k', state: 'detected', detectedAt: at }],
    });

    expect(timeline.map((e) => e.id)).toEqual([
      'approval:CHG-1',
      'config-diff:sha-z',
      'finding:k',
      'health-event:evt-a',
      'health-event:evt-b',
    ]);
  });

  it('can scope the read model to one device', () => {
    const timeline = buildTimeline({
      ...input,
      approvals: [
        ...input.approvals,
        { deviceId: 'dev-2', changeTicketId: 'CHG-OTHER', approvedAt: '2026-08-03T08:00:00.000Z' },
      ],
      deviceId: 'dev-1',
    });

    expect(timeline.every((e) => e.deviceId === 'dev-1')).toBe(true);
    expect(timeline).toHaveLength(4);
  });

  it('rejects an unparseable timestamp rather than sorting it to the epoch', () => {
    expect(() =>
      buildTimeline({ ...empty, approvals: [{ deviceId: 'dev-1', changeTicketId: 'CHG-X', approvedAt: 'soon' }] }),
    ).toThrow(/soon/u);
  });
});
