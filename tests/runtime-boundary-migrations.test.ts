import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  RuntimeSchemaError,
  parseRuntimeJsonLines,
} from '../packages/shared/src/runtime-schema.js';
import { runtimeBoundaryAppCases } from './helpers/runtime-boundary-app-cases.js';
import { runtimeBoundaryDomainACases } from './helpers/runtime-boundary-domain-a-cases.js';
import { runtimeBoundaryDomainBCases } from './helpers/runtime-boundary-domain-b-cases.js';
import { runtimeBoundaryScriptCases } from './helpers/runtime-boundary-script-cases.js';
import {
  REJECTED_RUNTIME_SECRET,
  type RuntimeBoundaryCase,
} from './helpers/runtime-boundary-case.js';

const inventoryBoundarySchema = z.object({
  id: z.string(),
  parser: z.string(),
  schemaName: z.string(),
  policy: z.enum(['freeze', 'deny', 'loud_failure', 'invalid_report', 'INDETERMINATE']),
}).strip();
const environmentBoundarySchema = inventoryBoundarySchema.extend({
  environmentVariable: z.string(),
});
const inventorySchema = z.object({
  version: z.literal(2),
  boundaries: z.array(inventoryBoundarySchema),
  environmentBoundaries: z.array(environmentBoundarySchema),
}).strip();
const cases: readonly RuntimeBoundaryCase[] = [
  ...runtimeBoundaryAppCases,
  ...runtimeBoundaryDomainACases,
  ...runtimeBoundaryDomainBCases,
  ...runtimeBoundaryScriptCases,
];
const inventory = inventorySchema.parse(JSON.parse(
  readFileSync('scripts/runtime-boundaries.inventory.json', 'utf8'),
));
const expectedEnvironmentBoundaries = [
  {
    id: 'MCP_OBSERVER_PROFILES_ENV',
    parser: 'parseObserverProfilesEnvironment',
    environmentVariable: 'SANGFOR_OBSERVER_PROFILES_JSON',
    schemaName: 'mcp-server.observer-profile-registry.v1',
    policy: 'deny',
  },
  {
    id: 'JM_OWNED_CDP_PROFILES_ENV',
    parser: 'parseOwnedCdpProfilesEnvironment',
    environmentVariable: 'SANGFOR_JM_CDP_PROFILES_JSON',
    schemaName: 'jm-execution.owned-cdp-profile-registry.v1',
    policy: 'deny',
  },
] as const;

function captureRuntimeSchemaError(action: () => unknown): RuntimeSchemaError {
  try {
    action();
  } catch (error) {
    if (error instanceof RuntimeSchemaError) return error;
    throw error;
  }
  throw new Error('Expected RuntimeSchemaError');
}

function policyCounts(values: readonly RuntimeBoundaryCase[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value.policy] = (counts[value.policy] ?? 0) + 1;
  return counts;
}

describe('runtime boundary inventory v2 behavior', () => {
  it('Given inventory v2, When cases are compared, Then 49 parser calls and two environment boundaries are separate', () => {
    // Given
    const actualIds = cases.map(({ id }) => id).sort();
    const inventoryIds = inventory.boundaries.map(({ id }) => id).sort();

    // When
    const uniqueIds = new Set(actualIds);

    // Then
    expect(cases).toHaveLength(49);
    expect(uniqueIds.size).toBe(49);
    expect(actualIds).toEqual(inventoryIds);
    expect(policyCounts(cases)).toEqual({
      freeze: 20,
      invalid_report: 6,
      deny: 9,
      INDETERMINATE: 5,
      loud_failure: 9,
    });
    expect(inventory.environmentBoundaries)
      .toEqual(expectedEnvironmentBoundaries);
    for (const boundary of inventory.boundaries) {
      expect(cases.find(({ id }) => id === boundary.id)).toMatchObject({
        schemaName: boundary.schemaName,
        policy: boundary.policy,
      });
    }
  });

  it.each(cases)('Given valid $id input, When its named parser runs, Then typed data is returned', (boundary) => {
    // Given
    const source = JSON.stringify(boundary.valid);

    // When
    const parse = () => boundary.parse(source);

    // Then
    expect(parse).not.toThrow();
  });

  it.each(cases)('Given parseable invalid $id input, When its named parser runs, Then its exact redacted policy rejects', (boundary) => {
    // Given
    const source = JSON.stringify(boundary.invalid);
    expect(() => JSON.parse(source)).not.toThrow();

    // When
    const error = captureRuntimeSchemaError(() => boundary.parse(source));

    // Then
    expect(error).toMatchObject({
      name: 'RuntimeSchemaError',
      schemaName: boundary.schemaName,
      policy: boundary.policy,
    });
    expect(error.issues.length).toBeGreaterThan(0);
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(REJECTED_RUNTIME_SECRET);
  });

  it('Given valid JSONL, When strict line parsing runs, Then every line is typed', () => {
    // Given
    const source = '{"id":"one"}\n{"id":"two"}\n';
    const contract = {
      schema: z.object({ id: z.string() }).strict(),
      schemaName: 'jsonl-fixture.v1',
      policy: 'freeze',
    } as const;

    // When
    const records = parseRuntimeJsonLines(source, contract);

    // Then
    expect(records).toEqual([{ id: 'one' }, { id: 'two' }]);
  });

  it('Given a truncated final JSONL record, When strict line parsing runs, Then the line is visible and never skipped', () => {
    // Given
    const source = '{"id":"one"}\n{"id":"two"';
    const contract = {
      schema: z.object({ id: z.string() }).strict(),
      schemaName: 'jsonl-fixture.v1',
      policy: 'freeze',
    } as const;

    // When
    const error = captureRuntimeSchemaError(() => parseRuntimeJsonLines(source, contract));

    // Then
    expect(error.issues).toEqual([{ code: 'malformed_json', path: [2] }]);
  });
});
