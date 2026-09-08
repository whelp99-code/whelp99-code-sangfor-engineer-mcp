import { testLocalWriteAuthority } from './helpers/local-write-authority.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listSnapshots, recordSnapshot } from '../packages/sangfor-chronicle/src/index.js';
import { queryDevices, type QueryChains } from '../packages/sangfor-scorecard/src/index.js';

function snap(deviceId: string, capturedAt: string, observed: Record<string, unknown>) {
  return { deviceId, capturedAt, observed } as const;
}

const chains: QueryChains = {
  'hci-1': [
    snap('hci-1', '2026-08-01T00:00:00.000Z', { firmware: '6.8.0', mtu: 1500 }),
    snap('hci-1', '2026-08-05T00:00:00.000Z', { firmware: '6.10.0', mtu: 1500 }),
  ],
  'hci-2': [
    snap('hci-2', '2026-08-02T00:00:00.000Z', { firmware: '6.12.0', mtu: 9000 }),
  ],
  'hci-3': [
    snap('hci-3', '2026-08-09T00:00:00.000Z', { firmware: '6.9.0', mtu: 9000 }),
  ],
};

describe('@sangfor/scorecard — snapshot query language (design 002, block H1)', () => {
  it('matches on equality against the latest snapshot per device and returns the matched value', () => {
    const result = queryDevices({ chains, where: { key: 'mtu', op: 'eq', value: 9000 } });

    expect(result.matches).toEqual([
      { deviceId: 'hci-2', value: 9000, capturedAt: '2026-08-02T00:00:00.000Z' },
      { deviceId: 'hci-3', value: 9000, capturedAt: '2026-08-09T00:00:00.000Z' },
    ]);
    expect(result.noData).toEqual([]);
  });

  it('supports neq, lt, gte and exists', () => {
    expect(queryDevices({ chains, where: { key: 'mtu', op: 'neq', value: 9000 } }).matches.map((m) => m.deviceId))
      .toEqual(['hci-1']);
    expect(queryDevices({ chains, where: { key: 'firmware', op: 'lt', value: '6.10.0' } }).matches.map((m) => m.deviceId))
      .toEqual(['hci-3']); // hci-1 is on 6.10.0 (not <), hci-2 on 6.12.0, hci-3 on 6.9.0
    expect(queryDevices({ chains, where: { key: 'mtu', op: 'gte', value: 9000 } }).matches.map((m) => m.deviceId))
      .toEqual(['hci-2', 'hci-3']);
    expect(queryDevices({ chains, where: { key: 'firmware', op: 'exists', value: null } }).matches.map((m) => m.deviceId))
      .toEqual(['hci-1', 'hci-2', 'hci-3']);
  });

  it('reports a device whose latest snapshot lacks the key under noData, never as a match', () => {
    const sparse: QueryChains = {
      ...chains,
      'ngfw-1': [snap('ngfw-1', '2026-08-03T00:00:00.000Z', { firmware: '8.0.75' })],
    };
    const result = queryDevices({ chains: sparse, where: { key: 'mtu', op: 'neq', value: 9000 } });

    expect(result.matches.map((m) => m.deviceId)).toEqual(['hci-1']);
    expect(result.noData).toEqual([{ deviceId: 'ngfw-1', reason: 'key-absent' }]);
  });

  it('reports a device with an empty chain under noData', () => {
    const result = queryDevices({ chains: { 'hci-9': [] }, where: { key: 'mtu', op: 'exists', value: null } });
    expect(result.matches).toEqual([]);
    expect(result.noData).toEqual([{ deviceId: 'hci-9', reason: 'no-snapshot' }]);
  });

  it('answers point-in-time: asOf picks the latest snapshot at or before the timestamp', () => {
    const result = queryDevices({
      chains,
      where: { key: 'firmware', op: 'lt', value: '6.11.0' },
      asOf: '2026-08-03T00:00:00.000Z',
    });

    // hci-1 was on 6.8.0 at that time (its 6.10.0 snapshot is later but still < 6.11.0 either way),
    // hci-2 was already on 6.12.0, and hci-3 had no snapshot yet.
    expect(result.matches).toEqual([
      { deviceId: 'hci-1', value: '6.8.0', capturedAt: '2026-08-01T00:00:00.000Z' },
    ]);
    expect(result.noData).toEqual([{ deviceId: 'hci-3', reason: 'no-snapshot-before-asOf' }]);
  });

  it('includes a snapshot captured exactly at asOf (boundary is inclusive)', () => {
    const result = queryDevices({
      chains,
      where: { key: 'firmware', op: 'exists', value: null },
      asOf: '2026-08-02T00:00:00.000Z',
    });

    expect(result.matches.map((m) => `${m.deviceId}:${String(m.value)}`)).toEqual(['hci-1:6.8.0', 'hci-2:6.12.0']);
    expect(result.noData).toEqual([{ deviceId: 'hci-3', reason: 'no-snapshot-before-asOf' }]);
  });

  it('never matches a device that has no snapshot before asOf, even if a later snapshot would match', () => {
    const result = queryDevices({
      chains,
      where: { key: 'mtu', op: 'eq', value: 9000 },
      asOf: '2026-08-01T12:00:00.000Z',
    });

    expect(result.matches).toEqual([]);
    expect(result.noData.map((entry) => entry.deviceId)).toEqual(['hci-2', 'hci-3']);
  });

  it('orders snapshots by capturedAt rather than trusting array order', () => {
    const outOfOrder: QueryChains = {
      'hci-1': [
        snap('hci-1', '2026-08-05T00:00:00.000Z', { mtu: 9000 }),
        snap('hci-1', '2026-08-01T00:00:00.000Z', { mtu: 1500 }),
      ],
    };
    expect(queryDevices({ chains: outOfOrder, where: { key: 'mtu', op: 'eq', value: 9000 } }).matches).toEqual([
      { deviceId: 'hci-1', value: 9000, capturedAt: '2026-08-05T00:00:00.000Z' },
    ]);
  });

  it('orders dotted version strings numerically, not lexicographically', () => {
    // Plain string comparison would put '6.8.0' ABOVE '6.11.0' and silently
    // drop the device the "below 6.11" query exists to find.
    const versions: QueryChains = {
      'a': [snap('a', '2026-08-01T00:00:00.000Z', { firmware: '6.8.0' })],
      'b': [snap('b', '2026-08-01T00:00:00.000Z', { firmware: '6.11.0' })],
      'c': [snap('c', '2026-08-01T00:00:00.000Z', { firmware: '6.12.3' })],
    };
    expect(queryDevices({ chains: versions, where: { key: 'firmware', op: 'lt', value: '6.11' } }).matches.map((m) => m.deviceId))
      .toEqual(['a']);
    expect(queryDevices({ chains: versions, where: { key: 'firmware', op: 'gte', value: '6.11' } }).matches.map((m) => m.deviceId))
      .toEqual(['b', 'c']);
  });

  it('still compares non-version strings lexicographically', () => {
    const names: QueryChains = {
      'a': [snap('a', '2026-08-01T00:00:00.000Z', { site: 'busan' })],
      'b': [snap('b', '2026-08-01T00:00:00.000Z', { site: 'seoul' })],
    };
    expect(queryDevices({ chains: names, where: { key: 'site', op: 'lt', value: 'daegu' } }).matches.map((m) => m.deviceId))
      .toEqual(['a']);
  });

  it('rejects an unknown operator instead of silently matching nothing', () => {
    expect(() =>
      queryDevices({ chains, where: { key: 'mtu', op: 'contains' as never, value: 9000 } }),
    ).toThrow(/contains/);
  });
});

describe('@sangfor/scorecard — query over a real chronicle store', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'scorecard-query-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('answers "HCI below 6.11 whose MTU is not 9000" over chronicle chains at a point in time', async () => {
    await recordSnapshot({ deviceId: 'hci-1', observed: { firmware: '6.8.0', mtu: 1500 }, capturedAt: '2026-08-01T00:00:00.000Z', dir , authority: testLocalWriteAuthority('config_chronicle_state', dir)});
    await recordSnapshot({ deviceId: 'hci-1', observed: { firmware: '6.8.0', mtu: 9000 }, capturedAt: '2026-08-07T00:00:00.000Z', dir , authority: testLocalWriteAuthority('config_chronicle_state', dir)});
    await recordSnapshot({ deviceId: 'hci-2', observed: { firmware: '6.12.0', mtu: 1500 }, capturedAt: '2026-08-01T00:00:00.000Z', dir , authority: testLocalWriteAuthority('config_chronicle_state', dir)});

    const built: QueryChains = {
      'hci-1': listSnapshots('hci-1', dir),
      'hci-2': listSnapshots('hci-2', dir),
    };

    const belowSixEleven = queryDevices({
      chains: built,
      where: { key: 'firmware', op: 'lt', value: '6.11' },
      asOf: '2026-08-03T00:00:00.000Z',
    }).matches.map((match) => match.deviceId);
    expect(belowSixEleven).toEqual(['hci-1']);

    const wrongMtu = queryDevices({
      chains: built,
      where: { key: 'mtu', op: 'neq', value: 9000 },
      asOf: '2026-08-03T00:00:00.000Z',
    }).matches;
    expect(wrongMtu).toEqual([
      { deviceId: 'hci-1', value: 1500, capturedAt: '2026-08-01T00:00:00.000Z' },
      { deviceId: 'hci-2', value: 1500, capturedAt: '2026-08-01T00:00:00.000Z' },
    ]);

    // The later 9000 snapshot is invisible at asOf but visible now.
    const nowWrongMtu = queryDevices({ chains: built, where: { key: 'mtu', op: 'neq', value: 9000 } }).matches;
    expect(nowWrongMtu.map((m) => m.deviceId)).toEqual(['hci-2']);
  });
});
