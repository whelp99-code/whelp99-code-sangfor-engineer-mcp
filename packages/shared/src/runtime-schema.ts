import type { z } from 'zod';

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
  'unknown_version',
  'prototype_key',
  'max_depth_exceeded',
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

export type RuntimeSchemaContract<TOutput, TInput = TOutput> = {
  readonly schema: z.ZodType<TOutput, z.ZodTypeDef, TInput>;
  readonly schemaName: string;
  readonly policy: RuntimeFailurePolicy;
  readonly expectedVersion?: string | number;
  readonly maxDepth?: number;
  readonly uniqueIdCollectionPath?: readonly string[];
};

type TraversalNode = {
  readonly value: unknown;
  readonly depth: number;
  readonly path: readonly (string | number)[];
};

const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const DEFAULT_MAX_DEPTH = 64;

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function inspectJsonTree(value: unknown, maxDepth: number): RuntimeSchemaIssue | undefined {
  const pending: TraversalNode[] = [{ value, depth: 0, path: [] }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    if (current.depth > maxDepth) return { code: 'max_depth_exceeded', path: [] };

    if (Array.isArray(current.value)) {
      for (const [index, child] of current.value.entries()) {
        pending.push({ value: child, depth: current.depth + 1, path: [...current.path, index] });
      }
      continue;
    }
    if (!isJsonRecord(current.value)) continue;
    for (const [key, child] of Object.entries(current.value)) {
      if (PROTOTYPE_KEYS.has(key)) return { code: 'prototype_key', path: [...current.path, key] };
      pending.push({ value: child, depth: current.depth + 1, path: [...current.path, key] });
    }
  }
  return undefined;
}

function valueAtPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (!isJsonRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function duplicateIdIssue(value: unknown, path: readonly string[]): RuntimeSchemaIssue | undefined {
  const collection = valueAtPath(value, path);
  if (!Array.isArray(collection)) return undefined;
  const ids = new Set<string | number>();
  for (const [index, item] of collection.entries()) {
    if (!isJsonRecord(item)) continue;
    const id = item['id'];
    if (typeof id !== 'string' && typeof id !== 'number') continue;
    if (ids.has(id)) return { code: 'duplicate_id', path: [...path, index, 'id'] };
    ids.add(id);
  }
  return undefined;
}

function reject(
  contract: { readonly schemaName: string; readonly policy: RuntimeFailurePolicy },
  issue: RuntimeSchemaIssue,
): never {
  throw new RuntimeSchemaError(contract.schemaName, contract.policy, [issue]);
}

export function parseRuntimeJson<TOutput, TInput>(
  source: string,
  contract: RuntimeSchemaContract<TOutput, TInput>,
): TOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    if (error instanceof SyntaxError) reject(contract, { code: 'malformed_json', path: [] });
    throw error;
  }

  const structuralIssue = inspectJsonTree(parsed, contract.maxDepth ?? DEFAULT_MAX_DEPTH);
  if (structuralIssue !== undefined) reject(contract, structuralIssue);

  if (
    contract.expectedVersion !== undefined
    && (!isJsonRecord(parsed) || parsed['version'] !== contract.expectedVersion)
  ) {
    reject(contract, { code: 'unknown_version', path: ['version'] });
  }

  if (contract.uniqueIdCollectionPath !== undefined) {
    const issue = duplicateIdIssue(parsed, contract.uniqueIdCollectionPath);
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
