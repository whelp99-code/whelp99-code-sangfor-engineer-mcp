import { describe, expect, it } from 'vitest';
import {
  enqueueTargetedRecollect,
  parsePassiveEvent,
  type DeviceRegistry,
  type PassiveEvent,
  type RecollectQueue,
} from '../packages/sangfor-acquisition/src/index.js';

const registry: DeviceRegistry = {
  byHostname: { 'hci-node-1': 'dev-hci-1', 'ngfw-edge': 'dev-ngfw-1' },
  byAddress: { '10.0.0.11': 'dev-hci-1' },
};

const emptyQueue: RecollectQueue = { entries: [], unmatched: [] };

describe('@sangfor/acquisition — passive event parsing (design 002, C1)', () => {
  it('parses a syslog-shaped line into a device hint, kind, severity and timestamp', () => {
    const line = '<27>1 2026-08-18T04:05:06.000Z hci-node-1 sangfor-hci - - - HA state changed to standby';
    expect(parsePassiveEvent(line)).toEqual<PassiveEvent>({
      deviceHint: 'hci-node-1',
      eventKind: 'ha-state-change',
      severity: 'error',
      at: '2026-08-18T04:05:06.000Z',
    });
  });

  it('maps syslog priority to severity without inventing a kind for unknown text', () => {
    const line = '<30>1 2026-08-18T04:05:06.000Z ngfw-edge sangfor-ngfw - - - session table nearing capacity';
    expect(parsePassiveEvent(line)).toEqual<PassiveEvent>({
      deviceHint: 'ngfw-edge',
      eventKind: 'unclassified',
      severity: 'info',
      at: '2026-08-18T04:05:06.000Z',
    });
  });

  it('parses a JSON webhook payload', () => {
    const line = JSON.stringify({
      host: '10.0.0.11',
      event: 'link-down',
      severity: 'critical',
      timestamp: '2026-08-18T05:00:00.000Z',
    });
    expect(parsePassiveEvent(line)).toEqual<PassiveEvent>({
      deviceHint: '10.0.0.11',
      eventKind: 'link-down',
      severity: 'critical',
      at: '2026-08-18T05:00:00.000Z',
    });
  });

  it('returns null rather than guessing when the line is unparseable', () => {
    expect(parsePassiveEvent('')).toBeNull();
    expect(parsePassiveEvent('   ')).toBeNull();
    expect(parsePassiveEvent('random operator note about the firewall')).toBeNull();
    // JSON without a usable host or timestamp is still not an event.
    expect(parsePassiveEvent(JSON.stringify({ event: 'link-down' }))).toBeNull();
    expect(parsePassiveEvent(JSON.stringify({ host: 'hci-node-1', event: 'link-down', timestamp: 'not-a-date' }))).toBeNull();
    // A syslog line whose timestamp cannot be parsed must not be back-dated to now.
    expect(parsePassiveEvent('<27>1 yesterday hci-node-1 sangfor-hci - - - HA state changed')).toBeNull();
  });

  it('does not trust a JSON severity outside the known ladder', () => {
    const line = JSON.stringify({
      host: 'hci-node-1',
      event: 'link-down',
      severity: 'apocalyptic',
      timestamp: '2026-08-18T05:00:00.000Z',
    });
    expect(parsePassiveEvent(line)?.severity).toBe('info');
  });
});

describe('@sangfor/acquisition — targeted re-collection queue (design 002, C1)', () => {
  const event = (over: Partial<PassiveEvent> = {}): PassiveEvent => ({
    deviceHint: 'hci-node-1',
    eventKind: 'ha-state-change',
    severity: 'error',
    at: '2026-08-18T04:05:06.000Z',
    ...over,
  });

  it('resolves a hostname hint to the registered device id', () => {
    const next = enqueueTargetedRecollect(emptyQueue, event(), registry, { dedupeWindowMs: 60_000 });
    expect(next.entries).toEqual([
      {
        deviceId: 'dev-hci-1',
        eventKind: 'ha-state-change',
        severity: 'error',
        requestedAt: '2026-08-18T04:05:06.000Z',
        occurrences: 1,
      },
    ]);
    expect(next.unmatched).toEqual([]);
  });

  it('resolves an address hint and is case-insensitive on hostnames', () => {
    const byAddress = enqueueTargetedRecollect(emptyQueue, event({ deviceHint: '10.0.0.11' }), registry, { dedupeWindowMs: 60_000 });
    expect(byAddress.entries[0]?.deviceId).toBe('dev-hci-1');
    const upper = enqueueTargetedRecollect(emptyQueue, event({ deviceHint: 'HCI-NODE-1' }), registry, { dedupeWindowMs: 60_000 });
    expect(upper.entries[0]?.deviceId).toBe('dev-hci-1');
  });

  it('records an unknown hint as unmatched instead of dropping it', () => {
    const next = enqueueTargetedRecollect(emptyQueue, event({ deviceHint: 'mystery-box' }), registry, { dedupeWindowMs: 60_000 });
    expect(next.entries).toEqual([]);
    expect(next.unmatched).toEqual([
      { deviceHint: 'mystery-box', eventKind: 'ha-state-change', severity: 'error', at: '2026-08-18T04:05:06.000Z', reason: 'unknown-device-hint' },
    ]);
  });

  it('collapses the same device+kind inside the injected dedupe window and counts occurrences', () => {
    const first = enqueueTargetedRecollect(emptyQueue, event(), registry, { dedupeWindowMs: 60_000 });
    const second = enqueueTargetedRecollect(first, event({ at: '2026-08-18T04:05:36.000Z' }), registry, { dedupeWindowMs: 60_000 });
    expect(second.entries).toHaveLength(1);
    expect(second.entries[0]).toEqual({
      deviceId: 'dev-hci-1',
      eventKind: 'ha-state-change',
      severity: 'error',
      requestedAt: '2026-08-18T04:05:06.000Z',
      occurrences: 2,
    });
  });

  it('escalates the collapsed entry severity to the worst seen', () => {
    const first = enqueueTargetedRecollect(emptyQueue, event({ severity: 'info' }), registry, { dedupeWindowMs: 60_000 });
    const second = enqueueTargetedRecollect(first, event({ severity: 'critical', at: '2026-08-18T04:05:10.000Z' }), registry, { dedupeWindowMs: 60_000 });
    expect(second.entries[0]?.severity).toBe('critical');
    const third = enqueueTargetedRecollect(second, event({ severity: 'info', at: '2026-08-18T04:05:20.000Z' }), registry, { dedupeWindowMs: 60_000 });
    expect(third.entries[0]?.severity).toBe('critical');
  });

  it('does not collapse outside the window, nor across kinds or devices', () => {
    const first = enqueueTargetedRecollect(emptyQueue, event(), registry, { dedupeWindowMs: 60_000 });
    const late = enqueueTargetedRecollect(first, event({ at: '2026-08-18T04:06:07.000Z' }), registry, { dedupeWindowMs: 60_000 });
    expect(late.entries).toHaveLength(2);

    const otherKind = enqueueTargetedRecollect(first, event({ eventKind: 'link-down' }), registry, { dedupeWindowMs: 60_000 });
    expect(otherKind.entries).toHaveLength(2);

    const otherDevice = enqueueTargetedRecollect(first, event({ deviceHint: 'ngfw-edge' }), registry, { dedupeWindowMs: 60_000 });
    expect(otherDevice.entries).toHaveLength(2);
  });

  it('is pure — the input queue is never mutated', () => {
    const start: RecollectQueue = { entries: [], unmatched: [] };
    const next = enqueueTargetedRecollect(start, event(), registry, { dedupeWindowMs: 60_000 });
    expect(start.entries).toEqual([]);
    expect(next).not.toBe(start);
    const dup = enqueueTargetedRecollect(next, event({ at: '2026-08-18T04:05:16.000Z' }), registry, { dedupeWindowMs: 60_000 });
    expect(next.entries[0]?.occurrences).toBe(1);
    expect(dup.entries[0]?.occurrences).toBe(2);
  });
});
