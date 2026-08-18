import { describe, expect, it } from 'vitest';
import {
  COLLECTION_PROFILES,
  getProfile,
  selectIncremental,
  selectProfile,
  type CollectionProfile,
  type CollectionProfileName,
} from '../packages/sangfor-acquisition/src/index.js';

const names: CollectionProfileName[] = ['fast-health', 'daily-inventory', 'deep-audit', 'incident-capture'];

describe('@sangfor/acquisition — collection profiles as data (design 002, C3)', () => {
  it('declares exactly the four profiles', () => {
    expect(COLLECTION_PROFILES.map((p) => p.name)).toEqual(names);
  });

  it('gives every profile observedKey globs and hard collection ceilings', () => {
    for (const profile of COLLECTION_PROFILES) {
      expect(profile.observedKeyGlobs.length).toBeGreaterThan(0);
      expect(profile.maxDurationMs).toBeGreaterThan(0);
      expect(profile.maxApiCalls).toBeGreaterThan(0);
    }
  });

  it('orders the profiles from cheapest to most expensive', () => {
    const byName = (name: CollectionProfileName): CollectionProfile => getProfile(name);
    expect(byName('fast-health').maxApiCalls).toBeLessThan(byName('daily-inventory').maxApiCalls);
    expect(byName('daily-inventory').maxApiCalls).toBeLessThan(byName('deep-audit').maxApiCalls);
    expect(byName('fast-health').maxDurationMs).toBeLessThan(byName('deep-audit').maxDurationMs);
  });

  it('exposes profiles by name and rejects an unknown name', () => {
    expect(getProfile('deep-audit').name).toBe('deep-audit');
    expect(() => getProfile('turbo' as CollectionProfileName)).toThrow(/unknown collection profile/i);
  });
});

describe('@sangfor/acquisition — deterministic profile selection (design 002, C3)', () => {
  const now = '2026-08-18T06:00:00.000Z';

  it('always picks incident-capture while an incident is open, whatever the trigger', () => {
    for (const trigger of ['schedule', 'passive-event', 'manual'] as const) {
      expect(selectProfile({ trigger, lastFullAt: now, now, incident: true }).name).toBe('incident-capture');
    }
  });

  it('picks fast-health for a passive event on a recently audited device', () => {
    expect(selectProfile({ trigger: 'passive-event', lastFullAt: '2026-08-18T02:00:00.000Z', now, incident: false }).name)
      .toBe('fast-health');
  });

  it('escalates a scheduled run to daily-inventory once a day has passed', () => {
    expect(selectProfile({ trigger: 'schedule', lastFullAt: '2026-08-18T05:00:00.000Z', now, incident: false }).name)
      .toBe('fast-health');
    expect(selectProfile({ trigger: 'schedule', lastFullAt: '2026-08-17T05:00:00.000Z', now, incident: false }).name)
      .toBe('daily-inventory');
  });

  it('escalates to deep-audit when the last full collection is a week old or missing', () => {
    expect(selectProfile({ trigger: 'schedule', lastFullAt: '2026-08-10T05:00:00.000Z', now, incident: false }).name)
      .toBe('deep-audit');
    expect(selectProfile({ trigger: 'passive-event', lastFullAt: undefined, now, incident: false }).name)
      .toBe('deep-audit');
    // An unparseable timestamp must not be read as "recently collected".
    expect(selectProfile({ trigger: 'schedule', lastFullAt: 'never', now, incident: false }).name)
      .toBe('deep-audit');
  });

  it('is deterministic — same input, same profile', () => {
    const input = { trigger: 'schedule' as const, lastFullAt: '2026-08-17T05:00:00.000Z', now, incident: false };
    expect(selectProfile(input)).toEqual(selectProfile(input));
    expect(selectProfile(input)).toBe(getProfile('daily-inventory'));
  });
});

describe('@sangfor/acquisition — incremental key selection (design 002, C3)', () => {
  it('returns only keys matching a changed hint', () => {
    expect(selectIncremental({
      lastCollectedKeys: ['ha.state', 'ha.peer', 'net.interface.eth0.status', 'storage.pool.used'],
      changedHints: ['ha.*'],
    })).toEqual(['ha.state', 'ha.peer']);
  });

  it('supports single-segment and multi-segment globs', () => {
    const lastCollectedKeys = ['net.interface.eth0.status', 'net.interface.eth1.status', 'net.route.default'];
    expect(selectIncremental({ lastCollectedKeys, changedHints: ['net.interface.*.status'] }))
      .toEqual(['net.interface.eth0.status', 'net.interface.eth1.status']);
    expect(selectIncremental({ lastCollectedKeys, changedHints: ['net.**'] })).toEqual(lastCollectedKeys);
  });

  it('matches an exact key without any glob', () => {
    expect(selectIncremental({ lastCollectedKeys: ['ha.state', 'ha.peer'], changedHints: ['ha.state'] })).toEqual(['ha.state']);
  });

  it('deduplicates keys hit by several hints and preserves the collected order', () => {
    expect(selectIncremental({
      lastCollectedKeys: ['ha.state', 'ha.peer'],
      changedHints: ['ha.*', 'ha.state'],
    })).toEqual(['ha.state', 'ha.peer']);
  });

  it('refreshes nothing when no hint changed, and never invents unknown keys', () => {
    expect(selectIncremental({ lastCollectedKeys: ['ha.state'], changedHints: [] })).toEqual([]);
    expect(selectIncremental({ lastCollectedKeys: ['ha.state'], changedHints: ['storage.*'] })).toEqual([]);
    expect(selectIncremental({ lastCollectedKeys: [], changedHints: ['ha.*'] })).toEqual([]);
  });

  it('treats glob characters in a hint literally outside the wildcard syntax', () => {
    expect(selectIncremental({ lastCollectedKeys: ['ha.state', 'haXstate'], changedHints: ['ha.state'] })).toEqual(['ha.state']);
  });
});
