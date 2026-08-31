import { z } from 'zod';
import { runtimeJsonValueSchema } from '../../shared/src/runtime-json-codecs.js';
import { parseRuntimeJson, type RuntimeCodec } from '../../shared/src/runtime-schema.js';
import type { EvaluationResult, IntendedSpec } from './types.js';

const idSchema = z.string().min(1).max(512);
const textSchema = z.string().max(1_000_000);

const citationSchema = z.object({
  manual: textSchema,
  section: textSchema.optional(),
  page: textSchema.optional(),
}).strict();

const specItemSchema = z.object({
  id: idSchema,
  capabilityId: idSchema,
  label: textSchema,
  observedKey: idSchema,
  op: z.enum(['eq', 'neq', 'gte', 'lte', 'includes', 'oneOf', 'exists']),
  expected: runtimeJsonValueSchema.optional(),
  severity: z.enum(['must', 'recommended']),
  source: citationSchema.optional(),
  needsSeniorReview: z.boolean().optional(),
  contextDependent: z.boolean().optional(),
  maxAgeSec: z.number().finite().nonnegative().optional(),
}).strict();

export const intendedSpecRuntimeSchema: RuntimeCodec<IntendedSpec> = z.object({
  id: idSchema,
  product: idSchema,
  version: z.string().min(1).max(256).optional(),
  items: z.array(specItemSchema).max(100_000),
}).strict();

const observedSourceSchema = z.object({
  endpoint: textSchema.optional(),
  collectedAt: z.string().max(128).optional(),
  collector: idSchema.optional(),
}).strict();

const itemResultSchema = z.object({
  id: idSchema,
  label: textSchema,
  verdict: z.enum(['PASS', 'FAIL', 'INDETERMINATE']),
  category: z.enum(['ok', 'misconfiguration', 'missing', 'indeterminate', 'context_dependent']),
  observed: runtimeJsonValueSchema.optional(),
  observedSource: observedSourceSchema.optional(),
  expected: runtimeJsonValueSchema.optional(),
  reason: textSchema,
}).strict();

export const evaluationResultRuntimeSchema: RuntimeCodec<EvaluationResult> = z.object({
  specId: idSchema,
  ok: z.boolean(),
  items: z.array(itemResultSchema).max(100_000),
  summary: z.object({
    pass: z.number().int().nonnegative(),
    fail: z.number().int().nonnegative(),
    indeterminate: z.number().int().nonnegative(),
    misconfiguration: z.number().int().nonnegative(),
    missing: z.number().int().nonnegative(),
    contextDependent: z.number().int().nonnegative(),
  }).strict(),
  coverage: z.object({
    specifiedTotal: z.number().int().nonnegative(),
    observedTotal: z.number().int().nonnegative(),
    unspecifiedKeys: z.array(idSchema).max(100_000),
    unobservedItems: z.array(idSchema).max(100_000),
  }).strict(),
}).strict();

export function parseBoundaryIntendedSpecV1(source: string): IntendedSpec {
  return parseRuntimeJson(source, {
    schema: intendedSpecRuntimeSchema,
    schemaName: 'spec.intended-spec.v1',
    policy: 'deny',
    uniqueIdCollectionPath: ['items'],
  });
}
