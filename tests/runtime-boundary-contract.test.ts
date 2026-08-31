import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  RuntimeSchemaError,
  parseRuntimeJson,
} from '../packages/shared/src/runtime-schema.js';

const reportSchema = z.object({
  version: z.literal(1),
  records: z.array(z.object({ id: z.string(), status: z.string() }).strict()),
}).strict();

const reportContract = {
  schema: reportSchema,
  schemaName: 'runtime-report.v1',
  policy: 'invalid_report',
  expectedVersion: 1,
  uniqueIdCollectionPath: ['records'],
} as const;

function captureRuntimeSchemaError(action: () => unknown): RuntimeSchemaError {
  try {
    action();
  } catch (error) {
    if (error instanceof RuntimeSchemaError) return error;
    throw error;
  }
  throw new Error('Expected RuntimeSchemaError');
}

describe('runtime JSON boundary contract', () => {
  it('owns every unchecked production JSON assertion in the runtime inventory', () => {
    // Given
    const command = ['scripts/check-runtime-boundaries.mjs', '--json'];

    // When
    const result = spawnSync(process.execPath, command, { cwd: process.cwd(), encoding: 'utf8' });

    // Then
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      status: 'pass',
      message: 'RUNTIME_BOUNDARY_INVENTORY_V2_PASS',
      inventoryVersion: 2,
      strictCalls: 49,
      unsafeAssertions: 0,
      stale: 0,
      duplicate: 0,
      unowned: 0,
      policyCounts: {
        freeze: 20,
        deny: 9,
        loud_failure: 9,
        invalid_report: 6,
        INDETERMINATE: 5,
      },
    });
  });

  it('returns typed data when persisted JSON satisfies the declared contract', () => {
    // Given
    const source = JSON.stringify({ version: 1, records: [{ id: 'r-1', status: 'PASS' }] });

    // When
    const parsed = parseRuntimeJson(source, reportContract);

    // Then
    expect(parsed).toEqual({ version: 1, records: [{ id: 'r-1', status: 'PASS' }] });
  });

  it('reports malformed_json when JSON syntax is malformed', () => {
    // Given
    const source = '{"version":1';

    // When
    const error = captureRuntimeSchemaError(() => parseRuntimeJson(source, reportContract));

    // Then
    expect(error.issues).toEqual([{ code: 'malformed_json', path: [] }]);
  });

  it('reports unknown_version when persisted state has an unsupported version', () => {
    // Given
    const source = JSON.stringify({ version: 2, records: [] });

    // When
    const error = captureRuntimeSchemaError(() => parseRuntimeJson(source, reportContract));

    // Then
    expect(error.issues).toEqual([{ code: 'unknown_version', path: ['version'] }]);
  });

  it('reports prototype_key when untrusted JSON contains a prototype mutation key', () => {
    // Given
    const source = '{"version":1,"records":[],"__proto__":{"polluted":true}}';

    // When
    const error = captureRuntimeSchemaError(() => parseRuntimeJson(source, reportContract));

    // Then
    expect(error.issues).toEqual([{ code: 'prototype_key', path: ['__proto__'] }]);
  });

  it('reports max_depth_exceeded before traversing over-deep untrusted JSON', () => {
    // Given
    const source = JSON.stringify({ level1: { level2: { level3: true } } });
    const contract = {
      schema: z.unknown(),
      schemaName: 'depth-limited.v1',
      policy: 'loud_failure',
      maxDepth: 2,
    } as const;

    // When
    const error = captureRuntimeSchemaError(() => parseRuntimeJson(source, contract));

    // Then
    expect(error.issues).toEqual([{ code: 'max_depth_exceeded', path: [] }]);
  });

  it('reports duplicate_id without echoing the rejected identifier', () => {
    // Given
    const source = JSON.stringify({
      version: 1,
      records: [
        { id: 'customer-secret-id', status: 'PASS' },
        { id: 'customer-secret-id', status: 'PASS' },
      ],
    });

    // When
    const error = captureRuntimeSchemaError(() => parseRuntimeJson(source, reportContract));

    // Then
    expect(error.issues).toEqual([{ code: 'duplicate_id', path: ['records', 1, 'id'] }]);
  });

  it('rejects a source before parsing when its UTF-8 byte bound is exceeded', () => {
    // Given
    const source = JSON.stringify({ value: '123456789' });
    const contract = {
      schema: z.object({ value: z.string() }).strict(),
      schemaName: 'byte-limited.v1',
      policy: 'deny',
      maxBytes: 8,
    } as const;

    // When
    const error = captureRuntimeSchemaError(() => parseRuntimeJson(source, contract));

    // Then
    expect(error.issues).toEqual([{ code: 'source_too_large', path: [] }]);
  });

  it('rejects excessive breadth even when the JSON is shallow and schema-permissible', () => {
    // Given
    const source = JSON.stringify([1, 2, 3]);
    const contract = {
      schema: z.array(z.number()),
      schemaName: 'array-limited.v1',
      policy: 'loud_failure',
      maxArrayLength: 2,
    } as const;

    // When
    const error = captureRuntimeSchemaError(() => parseRuntimeJson(source, contract));

    // Then
    expect(error.issues).toEqual([{ code: 'max_array_length_exceeded', path: [] }]);
  });

  it('never echoes rejected secret values in the typed error shape', () => {
    // Given
    const secret = 'prod-password-SUPER-SECRET';
    const source = JSON.stringify({ version: 1, records: [], password: secret });

    // When
    const error = captureRuntimeSchemaError(() => parseRuntimeJson(source, reportContract));

    // Then
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(secret);
    expect(error).toMatchObject({
      name: 'RuntimeSchemaError',
      schemaName: 'runtime-report.v1',
      policy: 'invalid_report',
      issues: [{ code: 'schema_mismatch', path: [] }],
    });
  });
});
