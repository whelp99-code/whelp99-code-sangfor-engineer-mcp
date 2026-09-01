/**
 * The baseline is a completeness contract, not a collection of whatever the run
 * managed to gather. These tests pin the two ways a baseline lies: it omits a
 * source nobody notices is missing, and it reports an unavailable source as PASS.
 */
import { describe, expect, it } from 'vitest';
import {
  REQUIRED_BASELINE_SOURCES,
  assembleBaseline,
  parseObservations,
  type BaselineObservation,
  type BaselineSourceId,
} from '../scripts/lib/completeness-baseline.js';

const COLLECTED_AT = '2026-08-26T06:00:00.000Z';

function observation(
  sourceId: BaselineSourceId,
  overrides: Partial<BaselineObservation> = {},
): BaselineObservation {
  return {
    sourceId,
    origin: `fixture://${sourceId}`,
    collectedAt: COLLECTED_AT,
    command: `fixture ${sourceId}`,
    state: 'PASS',
    detail: `${sourceId} observed`,
    data: { sourceId },
    ...overrides,
  };
}

const everySource = (): BaselineObservation[] => REQUIRED_BASELINE_SOURCES.map((id) => observation(id));

describe('assembleBaseline — every required source must be present', () => {
  it('accepts a run that carries an observation for every required source', () => {
    // Given a run that observed all required sources
    const observations = everySource();

    // When the baseline is assembled
    const result = assembleBaseline(observations);

    // Then it is accepted and inventories exactly the required source set
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.baseline.sources.map((s) => s.sourceId)).toEqual([...REQUIRED_BASELINE_SOURCES]);
    expect(result.baseline.complete).toBe(true);
  });

  it.each([...REQUIRED_BASELINE_SOURCES])(
    'refuses the whole baseline with BASELINE_SOURCE_MISSING when %s is omitted',
    (omitted) => {
      // Given a run that silently dropped one source
      const observations = everySource().filter((o) => o.sourceId !== omitted);

      // When the baseline is assembled
      const result = assembleBaseline(observations);

      // Then the omission refuses the report and names the missing source
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.violations).toEqual([
        { code: 'BASELINE_SOURCE_MISSING', sourceId: omitted, detail: expect.stringContaining(omitted) },
      ]);
    },
  );

  it('refuses a duplicated source rather than letting the last observation win', () => {
    // Given two observations for one source, one PASS and one FAIL
    const duplicated = REQUIRED_BASELINE_SOURCES[0];
    const observations = [...everySource(), observation(duplicated, { state: 'FAIL', detail: 'contradicts the first' })];

    // When the baseline is assembled
    const result = assembleBaseline(observations);

    // Then the contradiction refuses the baseline instead of being resolved silently
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations).toEqual([
      { code: 'BASELINE_SOURCE_DUPLICATED', sourceId: duplicated, detail: expect.stringContaining(duplicated) },
    ]);
  });
});

describe('assembleBaseline — an unavailable source is never PASS', () => {
  it.each(['FAIL', 'BLOCKED', 'NOT_RUN'] as const)(
    'keeps the baseline incomplete and records %s verbatim',
    (state) => {
      // Given one source that could not be established
      const blocked = REQUIRED_BASELINE_SOURCES[3];
      const observations = everySource().map((o) =>
        o.sourceId === blocked ? { ...o, state, detail: 'the bridge is not running' } : o);

      // When the baseline is assembled
      const result = assembleBaseline(observations);

      // Then the baseline is emitted, marked incomplete, and the state survives unchanged
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.baseline.complete).toBe(false);
      expect(result.baseline.unavailableSources).toEqual([blocked]);
      expect(result.baseline.sources.find((s) => s.sourceId === blocked)?.state).toBe(state);
    },
  );
});

describe('parseObservations — collector output crosses the boundary once', () => {
  it('rejects an unknown state instead of coercing it toward PASS', () => {
    // Given a collector that emitted a state outside the closed set
    const malformed = JSON.stringify([{ ...observation(REQUIRED_BASELINE_SOURCES[0]), state: 'OK' }]);

    // When the payload is parsed
    const parse = (): readonly BaselineObservation[] => parseObservations(malformed);

    // Then it is refused
    expect(parse).toThrow(/RUNTIME_SCHEMA_INVALID/u);
  });

  it('rejects an unknown source id instead of inventing a tenth source', () => {
    // Given a collector that named a source the contract does not declare
    const malformed = JSON.stringify([{ ...observation(REQUIRED_BASELINE_SOURCES[0]), sourceId: 'invented_source' }]);

    // When the payload is parsed
    const parse = (): readonly BaselineObservation[] => parseObservations(malformed);

    // Then it is refused
    expect(parse).toThrow(/RUNTIME_SCHEMA_INVALID/u);
  });

  it('rejects a non-array payload', () => {
    // Given a collector that emitted an object where the contract demands a list
    const malformed = JSON.stringify({ sources: [] });

    // When the payload is parsed
    const parse = (): readonly BaselineObservation[] => parseObservations(malformed);

    // Then it is refused
    expect(parse).toThrow(/RUNTIME_SCHEMA_INVALID/u);
  });
});
