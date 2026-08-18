import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  findUnapprovedDrift,
  recordSnapshot,
  type ChangeApproval,
} from '../packages/sangfor-chronicle/src/index.js';

const base = { deviceId: 'dev-1' as const };

describe('@sangfor/chronicle — unapproved-drift read model', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'chronicle-drift-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function seedChain(): { first: string; second: string; third: string } {
    const first = recordSnapshot({ ...base, observed: { firmware: '8.0.75' }, capturedAt: '2026-08-01T00:00:00.000Z', dir }).hash;
    const second = recordSnapshot({ ...base, observed: { firmware: '8.0.80' }, capturedAt: '2026-08-02T12:00:00.000Z', dir }).hash;
    const third = recordSnapshot({ ...base, observed: { firmware: '8.0.80', ntpServer: '10.0.0.1' }, capturedAt: '2026-08-09T09:30:00.000Z', dir }).hash;
    return { first, second, third };
  }

  it('reports a finding for every drift when there are no approvals at all', () => {
    const { second, third } = seedChain();
    const findings = findUnapprovedDrift({ deviceId: 'dev-1', dir, approvals: [] });

    expect(findings).toEqual([
      {
        type: 'unapproved-drift',
        deviceId: 'dev-1',
        snapshotHash: second,
        keys: ['firmware'],
        capturedAt: '2026-08-02T12:00:00.000Z',
      },
      {
        type: 'unapproved-drift',
        deviceId: 'dev-1',
        snapshotHash: third,
        keys: ['ntpServer'],
        capturedAt: '2026-08-09T09:30:00.000Z',
      },
    ]);
  });

  it('suppresses a finding whose capturedAt falls inside an approval window for that device', () => {
    const { third } = seedChain();
    const approvals: readonly ChangeApproval[] = [
      {
        changeTicketId: 'CHG-1001',
        deviceId: 'dev-1',
        approvedAt: '2026-08-02T08:00:00.000Z',
        windowStartAt: '2026-08-02T10:00:00.000Z',
        windowEndAt: '2026-08-02T14:00:00.000Z',
      },
    ];

    const findings = findUnapprovedDrift({ deviceId: 'dev-1', dir, approvals });
    expect(findings.map((f) => f.snapshotHash)).toEqual([third]);
  });

  it('treats window bounds as inclusive', () => {
    const { second, third } = seedChain();
    const at = (start: string, end: string): readonly ChangeApproval[] => [
      { changeTicketId: 'CHG-1', deviceId: 'dev-1', approvedAt: '2026-08-01T00:00:00.000Z', windowStartAt: start, windowEndAt: end },
    ];

    // window that starts exactly at the snapshot instant
    expect(
      findUnapprovedDrift({ deviceId: 'dev-1', dir, approvals: at('2026-08-02T12:00:00.000Z', '2026-08-02T13:00:00.000Z') })
        .map((f) => f.snapshotHash),
    ).toEqual([third]);

    // window that ends exactly at the snapshot instant
    expect(
      findUnapprovedDrift({ deviceId: 'dev-1', dir, approvals: at('2026-08-02T11:00:00.000Z', '2026-08-02T12:00:00.000Z') })
        .map((f) => f.snapshotHash),
    ).toEqual([third]);

    // window that ends one millisecond early covers nothing
    expect(
      findUnapprovedDrift({ deviceId: 'dev-1', dir, approvals: at('2026-08-02T11:00:00.000Z', '2026-08-02T11:59:59.999Z') })
        .map((f) => f.snapshotHash),
    ).toEqual([second, third]);
  });

  it('ignores approvals belonging to a different device', () => {
    const { second, third } = seedChain();
    const approvals: readonly ChangeApproval[] = [
      {
        changeTicketId: 'CHG-2002',
        deviceId: 'dev-other',
        approvedAt: '2026-08-02T08:00:00.000Z',
        windowStartAt: '2026-08-01T00:00:00.000Z',
        windowEndAt: '2026-08-30T00:00:00.000Z',
      },
    ];

    expect(findUnapprovedDrift({ deviceId: 'dev-1', dir, approvals }).map((f) => f.snapshotHash))
      .toEqual([second, third]);
  });

  it('treats an approval with no explicit window as open-ended from approvedAt', () => {
    const { second, third } = seedChain();
    const approvals: readonly ChangeApproval[] = [
      { changeTicketId: 'CHG-3003', deviceId: 'dev-1', approvedAt: '2026-08-05T00:00:00.000Z' },
    ];

    // drift before approvedAt is still unapproved; drift after it is covered
    expect(findUnapprovedDrift({ deviceId: 'dev-1', dir, approvals }).map((f) => f.snapshotHash))
      .toEqual([second]);
    expect(third).toBeTruthy();
  });

  it('never reports the genesis snapshot as drift and returns [] for an unknown device', () => {
    recordSnapshot({ ...base, observed: { firmware: '8.0.75' }, capturedAt: '2026-08-01T00:00:00.000Z', dir });

    expect(findUnapprovedDrift({ deviceId: 'dev-1', dir, approvals: [] })).toEqual([]);
    expect(findUnapprovedDrift({ deviceId: 'dev-nope', dir, approvals: [] })).toEqual([]);
  });

  it('is a pure read model: it writes nothing (no new files, no mtime change)', () => {
    seedChain();
    const before = readdirSync(dir).map((name) => [name, statSync(join(dir, name)).mtimeMs] as const);

    findUnapprovedDrift({ deviceId: 'dev-1', dir, approvals: [] });
    findUnapprovedDrift({ deviceId: 'dev-unknown', dir, approvals: [] });

    const after = readdirSync(dir).map((name) => [name, statSync(join(dir, name)).mtimeMs] as const);
    expect(after).toEqual(before);
  });

  it('reports every changed key of a multi-key drift, sorted', () => {
    recordSnapshot({ ...base, observed: { a: 1, b: 2, c: 3 }, capturedAt: '2026-08-01T00:00:00.000Z', dir });
    const h = recordSnapshot({ ...base, observed: { a: 9, c: 3, d: 4 }, capturedAt: '2026-08-02T00:00:00.000Z', dir }).hash;

    const findings = findUnapprovedDrift({ deviceId: 'dev-1', dir, approvals: [] });
    expect(findings).toEqual([
      { type: 'unapproved-drift', deviceId: 'dev-1', snapshotHash: h, keys: ['a', 'b', 'd'], capturedAt: '2026-08-02T00:00:00.000Z' },
    ]);
  });
});
