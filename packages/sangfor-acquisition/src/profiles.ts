/**
 * Collection profiles and incremental collection (design 002, block C3).
 *
 * The four profiles are DATA, not code paths: each declares which observedKey
 * globs it covers plus hard ceilings (wall time, API calls) that the budget
 * manager and the collector enforce. Selection is a pure function of
 * (trigger, last full collection, now, incident) so the same inputs always
 * produce the same profile and a run is replayable from its ledger.
 *
 * Escalation is one-directional: staleness or an incident can only widen the
 * profile, never narrow it — a device we have not fully audited in a week is
 * never served by a fast-health sample.
 */

export type CollectionProfileName = 'fast-health' | 'daily-inventory' | 'deep-audit' | 'incident-capture';

export interface CollectionProfile {
  name: CollectionProfileName;
  /** observedKey globs this profile is allowed to collect. '*' = one segment, '**' = any depth. */
  observedKeyGlobs: readonly string[];
  maxDurationMs: number;
  maxApiCalls: number;
}

export type CollectionTrigger = 'schedule' | 'passive-event' | 'manual';

export interface SelectProfileInput {
  trigger: CollectionTrigger;
  /** ISO instant of the last full (deep-audit grade) collection, if any. */
  lastFullAt?: string;
  now: string;
  incident: boolean;
}

export interface SelectIncrementalInput {
  lastCollectedKeys: readonly string[];
  /** Globs or exact keys reported as changed (e.g. from a passive event or a diff). */
  changedHints: readonly string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const COLLECTION_PROFILES: readonly CollectionProfile[] = [
  {
    name: 'fast-health',
    observedKeyGlobs: ['ha.*', 'health.**', 'net.interface.*.status'],
    maxDurationMs: 15_000,
    maxApiCalls: 8,
  },
  {
    name: 'daily-inventory',
    observedKeyGlobs: ['ha.*', 'health.**', 'net.**', 'inventory.**', 'firmware.*', 'license.*'],
    maxDurationMs: 120_000,
    maxApiCalls: 60,
  },
  {
    name: 'deep-audit',
    observedKeyGlobs: ['**'],
    maxDurationMs: 900_000,
    maxApiCalls: 400,
  },
  {
    name: 'incident-capture',
    observedKeyGlobs: ['ha.**', 'health.**', 'net.**', 'log.**', 'session.**', 'cluster.**'],
    maxDurationMs: 300_000,
    maxApiCalls: 150,
  },
];

/** Look up a declared profile; an unknown name is a programming error, not a fallback. */
export function getProfile(name: CollectionProfileName): CollectionProfile {
  const profile = COLLECTION_PROFILES.find((p) => p.name === name);
  if (!profile) throw new Error(`Unknown collection profile "${name}"`);
  return profile;
}

/** Age in ms since the last full collection; Infinity when it is missing or unparseable. */
function ageSinceFull(lastFullAt: string | undefined, now: string): number {
  if (lastFullAt === undefined) return Number.POSITIVE_INFINITY;
  const last = Date.parse(lastFullAt);
  const current = Date.parse(now);
  if (Number.isNaN(last) || Number.isNaN(current)) return Number.POSITIVE_INFINITY;
  return current - last;
}

/**
 * Deterministic profile choice. An open incident always wins; otherwise the age
 * of the last full collection escalates fast-health → daily-inventory →
 * deep-audit. The trigger never narrows the result.
 */
export function selectProfile(input: SelectProfileInput): CollectionProfile {
  if (input.incident) return getProfile('incident-capture');
  const age = ageSinceFull(input.lastFullAt, input.now);
  if (age >= 7 * DAY_MS) return getProfile('deep-audit');
  if (age >= DAY_MS) return getProfile('daily-inventory');
  return getProfile('fast-health');
}

/** Compile one glob into an anchored regex. '**' spans segments, '*' spans one. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
  const pattern = escaped.replace(/\*\*/g, '\u0000').replace(/\*/g, '[^.]*').replace(/\u0000/g, '.*');
  return new RegExp(`^${pattern}$`);
}

/**
 * The subset of already-collected keys that a changed hint touches — the only
 * keys worth re-fetching. Order follows lastCollectedKeys so the result is
 * stable, and a hint matching nothing adds nothing (never invents a key).
 */
export function selectIncremental(input: SelectIncrementalInput): string[] {
  if (input.changedHints.length === 0) return [];
  const matchers = input.changedHints.map(globToRegExp);
  return input.lastCollectedKeys.filter((key) => matchers.some((re) => re.test(key)));
}
