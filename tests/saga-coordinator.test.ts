import { describe, expect, it } from 'vitest';
import type { EvaluationResult } from '../packages/sangfor-spec/src/index.js';
import type { EngineerReport } from '../packages/sangfor-engineer-report/src/index.js';
import {
  mergeReports,
  tick,
  type OpenFinding,
  type TickInput,
} from '../packages/sangfor-saga/src/index.js';

const NOW = '2026-08-18T12:00:00.000Z';

function finding(overrides: Partial<OpenFinding> = {}): OpenFinding {
  return {
    findingId: 'find_1',
    deviceId: 'fgt-01',
    agentKind: 'fortios-engineer',
    severity: 'must',
    openedAt: '2026-08-18T11:00:00.000Z',
    ...overrides,
  };
}

function tickInput(overrides: Partial<TickInput> = {}): TickInput {
  return {
    openFindings: [finding()],
    leases: [],
    deviceLocks: [],
    budgets: { maxTokens: 4000, maxToolCalls: 12, leaseSeconds: 300, deadlineSeconds: 600 },
    now: NOW,
    ...overrides,
  };
}

describe('@sangfor/saga — tick dispatch (F3)', () => {
  it('issues one work item per open finding with budgets taken from the input', () => {
    const items = tick(tickInput());

    expect(items).toHaveLength(1);
    expect(items[0].findingId).toBe('find_1');
    expect(items[0].deviceId).toBe('fgt-01');
    expect(items[0].agentKind).toBe('fortios-engineer');
    expect(items[0].budget).toEqual({
      maxTokens: 4000,
      maxToolCalls: 12,
      deadlineAt: '2026-08-18T12:10:00.000Z',
    });
    expect(items[0].leaseUntil).toBe('2026-08-18T12:05:00.000Z');
  });

  it('honours a per-finding budget override instead of the global default', () => {
    const items = tick(tickInput({
      openFindings: [finding({ budget: { maxTokens: 100, maxToolCalls: 2, deadlineSeconds: 60 } })],
    }));

    expect(items[0].budget).toEqual({ maxTokens: 100, maxToolCalls: 2, deadlineAt: '2026-08-18T12:01:00.000Z' });
  });

  it('refuses to invent a budget when neither input nor finding supplies one', () => {
    expect(() => tick({
      openFindings: [finding()],
      leases: [],
      deviceLocks: [],
      now: NOW,
    } as unknown as TickInput)).toThrow(/budget/i);
  });

  it('derives deterministic work item ids: same input twice produces identical output', () => {
    const a = tick(tickInput());
    const b = tick(tickInput());

    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(a[0].workItemId).toMatch(/^wi_/);
  });

  it('orders work items deterministically regardless of input ordering', () => {
    const findings = [
      finding({ findingId: 'find_b', deviceId: 'dev-b' }),
      finding({ findingId: 'find_a', deviceId: 'dev-a' }),
      finding({ findingId: 'find_c', deviceId: 'dev-c' }),
    ];
    const forward = tick(tickInput({ openFindings: findings }));
    const reversed = tick(tickInput({ openFindings: [...findings].reverse() }));

    expect(forward.map((i) => i.findingId)).toEqual(['find_a', 'find_b', 'find_c']);
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
  });
});

describe('@sangfor/saga — device exclusivity', () => {
  it('never issues two live work items for the same device in one tick', () => {
    const items = tick(tickInput({
      openFindings: [
        finding({ findingId: 'find_1' }),
        finding({ findingId: 'find_2' }),
      ],
    }));

    expect(items).toHaveLength(1);
    expect(items[0].findingId).toBe('find_1');
  });

  it('skips a finding whose device is held by an unexpired lease', () => {
    const items = tick(tickInput({
      leases: [{ deviceId: 'fgt-01', workItemId: 'wi_prev', leaseUntil: '2026-08-18T12:04:00.000Z' }],
    }));

    expect(items).toEqual([]);
  });

  it('reclaims a device whose lease already expired', () => {
    const items = tick(tickInput({
      leases: [{ deviceId: 'fgt-01', workItemId: 'wi_prev', leaseUntil: '2026-08-18T11:59:59.999Z' }],
    }));

    expect(items).toHaveLength(1);
    expect(items[0].deviceId).toBe('fgt-01');
  });

  it('treats a lease that expires exactly at now as expired (reclaimable)', () => {
    const items = tick(tickInput({
      leases: [{ deviceId: 'fgt-01', workItemId: 'wi_prev', leaseUntil: NOW }],
    }));

    expect(items).toHaveLength(1);
  });

  it('skips a finding whose device is held by an injected device lock', () => {
    const items = tick(tickInput({
      deviceLocks: [{ deviceId: 'fgt-01', engagementId: 'eng-1', holder: 'human-engineer', acquiredAt: '2026-08-18T10:00:00.000Z' }],
    }));

    expect(items).toEqual([]);
  });

  it('dispatches other devices while one device is locked', () => {
    const items = tick(tickInput({
      openFindings: [finding({ findingId: 'find_1' }), finding({ findingId: 'find_2', deviceId: 'fgt-02' })],
      deviceLocks: [{ deviceId: 'fgt-01', engagementId: 'eng-1', holder: 'human', acquiredAt: '2026-08-18T10:00:00.000Z' }],
    }));

    expect(items.map((i) => i.deviceId)).toEqual(['fgt-02']);
  });

  it('has no timers, no io: an empty finding list yields no work', () => {
    expect(tick(tickInput({ openFindings: [] }))).toEqual([]);
  });

  it('caps dispatch at maxConcurrentWorkItems when supplied', () => {
    const items = tick(tickInput({
      openFindings: [
        finding({ findingId: 'f1', deviceId: 'd1' }),
        finding({ findingId: 'f2', deviceId: 'd2' }),
        finding({ findingId: 'f3', deviceId: 'd3' }),
      ],
      maxConcurrentWorkItems: 2,
    }));

    expect(items.map((i) => i.deviceId)).toEqual(['d1', 'd2']);
  });

  it('counts live leases against the concurrency cap', () => {
    const items = tick(tickInput({
      openFindings: [finding({ findingId: 'f1', deviceId: 'd1' }), finding({ findingId: 'f2', deviceId: 'd2' })],
      leases: [{ deviceId: 'd9', workItemId: 'wi_live', leaseUntil: '2026-08-18T12:09:00.000Z' }],
      maxConcurrentWorkItems: 2,
    }));

    expect(items.map((i) => i.deviceId)).toEqual(['d1']);
  });
});

const engineResult: EvaluationResult = {
  specId: 'spec_fortios_8_0_0_policy',
  ok: false,
  items: [
    { id: 'ssl_inspection_enabled', label: 'ssl', verdict: 'FAIL', category: 'misconfiguration', observed: false, expected: true, reason: 'r' },
    { id: 'threat_logging_enabled', label: 'log', verdict: 'PASS', category: 'ok', observed: true, expected: true, reason: 'r' },
  ],
  summary: { pass: 1, fail: 1, indeterminate: 0, misconfiguration: 1, missing: 0, contextDependent: 0 },
  coverage: { specifiedTotal: 2, observedTotal: 2, unspecifiedKeys: [], unobservedItems: [] },
};

function report(overrides: Partial<EngineerReport> = {}): EngineerReport {
  return {
    schemaVersion: 1,
    reportId: 'rep_1',
    deviceId: 'fgt-01',
    snapshotHash: 'a'.repeat(64),
    engineResult,
    riskNote: 'risk',
    recommendations: ['enable ssl inspection'],
    rollbackPlan: ['restore previous profile'],
    ragCitations: [],
    modelId: 'm1',
    promptHash: 'b'.repeat(64),
    createdAt: '2026-08-18T12:00:00.000Z',
    ...overrides,
  } as EngineerReport;
}

describe('@sangfor/saga — mergeReports (structural merge, prose escalation)', () => {
  it('merges structural engine summaries across findings deterministically', () => {
    const merged = mergeReports([
      { findingId: 'find_1', report: report() },
      { findingId: 'find_2', report: report({ reportId: 'rep_2', deviceId: 'fgt-02' }) },
    ]);

    expect(merged.summary).toEqual({
      pass: 2, fail: 2, indeterminate: 0, misconfiguration: 2, missing: 0, contextDependent: 0,
    });
    expect(merged.reportIds).toEqual(['rep_1', 'rep_2']);
    expect(merged.deviceIds).toEqual(['fgt-01', 'fgt-02']);
    expect(merged.escalations).toEqual([]);
  });

  it('is order independent', () => {
    const a = mergeReports([
      { findingId: 'find_1', report: report() },
      { findingId: 'find_2', report: report({ reportId: 'rep_2', deviceId: 'fgt-02' }) },
    ]);
    const b = mergeReports([
      { findingId: 'find_2', report: report({ reportId: 'rep_2', deviceId: 'fgt-02' }) },
      { findingId: 'find_1', report: report() },
    ]);

    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('escalates — never silently picks — when two reports on the same finding disagree in prose', () => {
    const merged = mergeReports([
      { findingId: 'find_1', report: report({ reportId: 'rep_a', recommendations: ['enable ssl inspection'] }) },
      { findingId: 'find_1', report: report({ reportId: 'rep_b', recommendations: ['disable the policy entirely'] }) },
    ]);

    expect(merged.escalations).toEqual([
      { reason: 'conflicting-recommendations', findingId: 'find_1', cited: ['rep_a', 'rep_b'] },
    ]);
  });

  it('cites both report ids in a stable sorted order regardless of input order', () => {
    const merged = mergeReports([
      { findingId: 'find_1', report: report({ reportId: 'rep_b', recommendations: ['disable the policy entirely'] }) },
      { findingId: 'find_1', report: report({ reportId: 'rep_a', recommendations: ['enable ssl inspection'] }) },
    ]);

    expect(merged.escalations[0].cited).toEqual(['rep_a', 'rep_b']);
  });

  it('does not escalate when two reports on one finding agree verbatim on recommendations', () => {
    const merged = mergeReports([
      { findingId: 'find_1', report: report({ reportId: 'rep_a' }) },
      { findingId: 'find_1', report: report({ reportId: 'rep_b' }) },
    ]);

    expect(merged.escalations).toEqual([]);
  });

  it('ignores recommendation ordering when deciding agreement (set equality, not list equality)', () => {
    const merged = mergeReports([
      { findingId: 'find_1', report: report({ reportId: 'rep_a', recommendations: ['x', 'y'] }) },
      { findingId: 'find_1', report: report({ reportId: 'rep_b', recommendations: ['y', 'x'] }) },
    ]);

    expect(merged.escalations).toEqual([]);
  });

  it('escalates every conflicting finding, not just the first', () => {
    const merged = mergeReports([
      { findingId: 'find_1', report: report({ reportId: 'r1', recommendations: ['a'] }) },
      { findingId: 'find_1', report: report({ reportId: 'r2', recommendations: ['b'] }) },
      { findingId: 'find_2', report: report({ reportId: 'r3', recommendations: ['c'] }) },
      { findingId: 'find_2', report: report({ reportId: 'r4', recommendations: ['d'] }) },
    ]);

    expect(merged.escalations.map((e) => e.findingId)).toEqual(['find_1', 'find_2']);
    expect(merged.escalations.every((e) => e.reason === 'conflicting-recommendations')).toBe(true);
  });

  it('escalates a rollback-plan conflict too, with both reports cited', () => {
    const merged = mergeReports([
      { findingId: 'find_1', report: report({ reportId: 'r1', rollbackPlan: ['restore A'] }) },
      { findingId: 'find_1', report: report({ reportId: 'r2', rollbackPlan: ['wipe config'] }) },
    ]);

    expect(merged.escalations).toEqual([
      { reason: 'conflicting-rollback-plans', findingId: 'find_1', cited: ['r1', 'r2'] },
    ]);
  });

  it('escalates when two reports on the same finding carry different engine verdicts', () => {
    const flipped: EvaluationResult = JSON.parse(JSON.stringify(engineResult)) as EvaluationResult;
    (flipped.items[0] as { verdict: 'PASS' }).verdict = 'PASS';
    const merged = mergeReports([
      { findingId: 'find_1', report: report({ reportId: 'r1' }) },
      { findingId: 'find_1', report: report({ reportId: 'r2', engineResult: flipped }) },
    ]);

    expect(merged.escalations.map((e) => e.reason)).toContain('conflicting-engine-verdicts');
  });

  it('merges an empty report list into an empty structural summary', () => {
    const merged = mergeReports([]);

    expect(merged).toEqual({
      summary: { pass: 0, fail: 0, indeterminate: 0, misconfiguration: 0, missing: 0, contextDependent: 0 },
      reportIds: [],
      deviceIds: [],
      findingIds: [],
      escalations: [],
    });
  });

  it('never mutates the reports it is given', () => {
    const input = report();
    const snapshot = JSON.stringify(input);
    mergeReports([{ findingId: 'find_1', report: input }]);

    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
