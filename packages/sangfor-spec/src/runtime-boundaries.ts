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
  collectionStatus: z.enum(['complete', 'partial', 'failed']).optional(),
}).strict();

const assessmentReasonCodeSchema = z.enum([
  'ASSESSMENT_TIME_MISSING', 'ASSESSMENT_TIME_INVALID', 'FRESHNESS_POLICY_MISSING', 'FRESHNESS_POLICY_INVALID',
  'EVIDENCE_EXPIRED', 'EVIDENCE_MISSING', 'EVIDENCE_FUTURE', 'COLLECTION_INCOMPLETE', 'COLLECTION_UNPROVEN',
  'OBSERVED_VALUE_MISSING', 'OBSERVED_VALUE_INCOMPATIBLE', 'SENIOR_REVIEW_REQUIRED', 'CONFIRMED_FAIL',
]);
const assessmentActionCodeSchema = z.enum([
  'SET_FRESHNESS_POLICY', 'RECOLLECT_OBSERVATION', 'COMPLETE_COLLECTION', 'OBSERVE_REQUIRED_VALUE',
  'NORMALIZE_OBSERVED_VALUE', 'SET_ASSESSMENT_TIME', 'REQUEST_SENIOR_REVIEW', 'REVIEW_CONFIRMED_FAIL',
]);
const actionableReasonSchema = z.object({
  code: assessmentReasonCodeSchema,
  itemIds: z.array(idSchema).max(100_000).optional(),
}).strict();
const assessmentNextActionSchema = z.object({
  code: assessmentActionCodeSchema,
  label: textSchema,
  itemIds: z.array(idSchema).max(100_000).optional(),
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
  actionableReason: actionableReasonSchema.optional(),
  nextActions: z.array(assessmentNextActionSchema).max(100_000).optional(),
}).strict();

export const evaluationResultRuntimeSchema: RuntimeCodec<EvaluationResult> = z.object({
  specId: idSchema,
  ok: z.boolean(),
  assessment: z.object({
    mode: z.enum(['comparison', 'current', 'snapshot']),
    evaluatedAt: z.string().nullable(),
    freshnessRequired: z.boolean(),
  }).strict().optional(),
  actionableReasons: z.array(actionableReasonSchema).max(100_000).optional(),
  nextActions: z.array(assessmentNextActionSchema).max(100_000).optional(),
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
