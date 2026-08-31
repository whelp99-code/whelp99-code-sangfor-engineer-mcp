import type { z } from 'zod';
import {
  duplicateValueIssue,
  inspectJsonTree,
  valueAtPath,
} from './runtime-json-inspection.js';

export const RUNTIME_FAILURE_POLICIES = [
  'deny',
  'invalid_report',
  'INDETERMINATE',
  'freeze',
  'loud_failure',
] as const;

export type RuntimeFailurePolicy = (typeof RUNTIME_FAILURE_POLICIES)[number];

export const RUNTIME_SCHEMA_ISSUE_CODES = [
  'malformed_json',
  'source_too_large',
  'unknown_version',
  'prototype_key',
  'max_depth_exceeded',
  'max_nodes_exceeded',
  'max_array_length_exceeded',
  'max_object_keys_exceeded',
  'too_many_jsonl_records',
  'duplicate_id',
  'schema_mismatch',
] as const;

export type RuntimeSchemaIssueCode = (typeof RUNTIME_SCHEMA_ISSUE_CODES)[number];

export type RuntimeSchemaIssue = {
  readonly code: RuntimeSchemaIssueCode;
  readonly path: readonly (string | number)[];
};

export class RuntimeSchemaError extends Error {
  readonly name = 'RuntimeSchemaError';

  constructor(
    readonly schemaName: string,
    readonly policy: RuntimeFailurePolicy,
    readonly issues: readonly RuntimeSchemaIssue[],
  ) {
    super(`RUNTIME_SCHEMA_INVALID: ${schemaName} rejected input (${issues.map(({ code }) => code).join(',')})`);
  }
}

export type RuntimeCodec<TOutput, TInput = TOutput> = z.ZodType<TOutput, z.ZodTypeDef, TInput>;

export type NamedRuntimeCodec<TOutput, TInput = TOutput> = {
  readonly schema: RuntimeCodec<TOutput, TInput>;
  readonly schemaName: string;
};

type RuntimeVersion = string | number;

export type RuntimeSchemaContract<TOutput, TInput = TOutput> = NamedRuntimeCodec<TOutput, TInput> & {
  readonly policy: RuntimeFailurePolicy;
  readonly expectedVersion?: RuntimeVersion | readonly RuntimeVersion[];
  readonly versionPath?: readonly string[];
  readonly maxBytes?: number;
  readonly maxDepth?: number;
  readonly maxNodes?: number;
  readonly maxArrayLength?: number;
  readonly maxObjectKeys?: number;
  readonly uniqueIdCollectionPath?: readonly string[];
  readonly uniqueCollections?: readonly {
    readonly path: readonly string[];
    readonly key: string;
  }[];
};

export type RuntimeJsonLinesContract<TOutput, TInput = TOutput> = RuntimeSchemaContract<TOutput, TInput> & {
  readonly maxRecords?: number;
  readonly maxLineBytes?: number;
};

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_DEPTH = 64;
const DEFAULT_MAX_NODES = 1_000_000;
const DEFAULT_MAX_ARRAY_LENGTH = 250_000;
const DEFAULT_MAX_OBJECT_KEYS = 100_000;
const DEFAULT_MAX_JSONL_RECORDS = 100_000;
const DEFAULT_MAX_JSONL_LINE_BYTES = 8 * 1024 * 1024;

function reject(
  contract: { readonly schemaName: string; readonly policy: RuntimeFailurePolicy },
  issue: RuntimeSchemaIssue,
): never {
  throw new RuntimeSchemaError(contract.schemaName, contract.policy, [issue]);
}

function assertSourceBound(
  source: string,
  contract: { readonly schemaName: string; readonly policy: RuntimeFailurePolicy },
  maxBytes: number,
): void {
  if (Buffer.byteLength(source, 'utf8') > maxBytes) reject(contract, { code: 'source_too_large', path: [] });
}

function expectedVersions(contract: RuntimeSchemaContract<unknown, unknown>): readonly RuntimeVersion[] {
  const expected = contract.expectedVersion;
  if (expected === undefined) return [];
  if (typeof expected === 'string' || typeof expected === 'number') return [expected];
  return expected;
}

export function parseRuntimeJson<TOutput, TInput>(
  source: string,
  contract: RuntimeSchemaContract<TOutput, TInput>,
): TOutput {
  assertSourceBound(source, contract, contract.maxBytes ?? DEFAULT_MAX_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    if (error instanceof SyntaxError) reject(contract, { code: 'malformed_json', path: [] });
    throw error;
  }

  const structuralIssue = inspectJsonTree(parsed, {
    maxDepth: contract.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxNodes: contract.maxNodes ?? DEFAULT_MAX_NODES,
    maxArrayLength: contract.maxArrayLength ?? DEFAULT_MAX_ARRAY_LENGTH,
    maxObjectKeys: contract.maxObjectKeys ?? DEFAULT_MAX_OBJECT_KEYS,
  });
  if (structuralIssue !== undefined) reject(contract, structuralIssue);

  const versions = expectedVersions(contract);
  const versionPath = contract.versionPath ?? ['version'];
  const parsedVersion = valueAtPath(parsed, versionPath);
  if (
    versions.length > 0
    && (typeof parsedVersion !== 'string' && typeof parsedVersion !== 'number'
      || !versions.includes(parsedVersion))
  ) {
    reject(contract, { code: 'unknown_version', path: versionPath });
  }

  const uniqueCollections = [
    ...(contract.uniqueIdCollectionPath === undefined
      ? []
      : [{ path: contract.uniqueIdCollectionPath, key: 'id' }]),
    ...(contract.uniqueCollections ?? []),
  ];
  for (const collection of uniqueCollections) {
    const issue = duplicateValueIssue(parsed, collection.path, collection.key);
    if (issue !== undefined) reject(contract, issue);
  }

  const result = contract.schema.safeParse(parsed);
  if (!result.success) {
    throw new RuntimeSchemaError(
      contract.schemaName,
      contract.policy,
      result.error.issues.map(({ path }) => ({ code: 'schema_mismatch', path })),
    );
  }
  return result.data;
}

export function parseRuntimeJsonLines<TOutput, TInput>(
  source: string,
  contract: RuntimeJsonLinesContract<TOutput, TInput>,
): readonly TOutput[] {
  assertSourceBound(source, contract, contract.maxBytes ?? DEFAULT_MAX_BYTES);
  const records = source.split('\n')
    .map((line, index) => ({ line: line.trim(), index }))
    .filter(({ line }) => line.length > 0);
  if (records.length > (contract.maxRecords ?? DEFAULT_MAX_JSONL_RECORDS)) {
    reject(contract, { code: 'too_many_jsonl_records', path: [] });
  }
  return records.map(({ line, index }) => {
    try {
      return parseRuntimeJson(line, {
        ...contract,
        maxBytes: contract.maxLineBytes ?? DEFAULT_MAX_JSONL_LINE_BYTES,
      });
    } catch (error) {
      if (!(error instanceof RuntimeSchemaError)) throw error;
      throw new RuntimeSchemaError(
        error.schemaName,
        error.policy,
        error.issues.map((issue) => ({ ...issue, path: [index + 1, ...issue.path] })),
      );
    }
  });
}

export function parseBoundarySharedJsonlRecordV1<TOutput, TInput>(
  source: string,
  codec: NamedRuntimeCodec<TOutput, TInput>,
): TOutput {
  return parseRuntimeJson(source, {
    ...codec,
    schemaName: 'shared.jsonl-record.v1',
    policy: 'freeze',
  });
}
