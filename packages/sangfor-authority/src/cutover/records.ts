import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AuthorityCutoverError } from './errors.js';
import type { CutoverRecord } from './types.js';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const jsonStringSchema = z.string().refine((value) => !value.includes('\u0000'), 'must not contain NUL');
const jsonValueSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  jsonStringSchema, z.number().finite(), z.boolean(), z.null(),
  z.array(jsonValueSchema), z.record(jsonValueSchema),
]));
const cutoverRecordSchema = z.object({
  key: z.string().min(1).max(512).refine((value) => !value.includes('\u0000'), 'must not contain NUL'),
  payload: z.record(jsonValueSchema),
  provenance: z.object({
    tenantId: z.string().min(1),
    projectId: z.string().min(1),
    sourceRoot: z.string().min(1),
    source: z.string().min(1),
    ordinal: z.number().int().nonnegative(),
    sourceSha256: sha256Schema,
  }).strict(),
}).strict();

export function parseCutoverRecord(input: unknown): CutoverRecord {
  const parsed = cutoverRecordSchema.safeParse(input);
  if (!parsed.success) {
    throw new AuthorityCutoverError(
      'CUTOVER_RECORD_INVALID',
      parsed.error.issues.map((issue) => `${issue.path.join('.')}:${issue.message}`),
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function canonicalRecordSet(records: readonly CutoverRecord[]): {
  readonly count: number;
  readonly keys: readonly string[];
  readonly digest: string;
} {
  const sorted = [...records].sort((left, right) => left.key.localeCompare(right.key));
  const keys = sorted.map((record) => record.key);
  if (new Set(keys).size !== keys.length) throw new AuthorityCutoverError('CUTOVER_DUPLICATE_KEY', keys);
  const body = sorted.map((record) => canonicalJson(record)).join('\n');
  return { count: sorted.length, keys, digest: createHash('sha256').update(body).digest('hex') };
}
