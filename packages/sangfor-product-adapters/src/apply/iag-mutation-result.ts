import { z } from 'zod';
import { structuralIagMutationActionSchema } from './iag-mutation-action.js';
import { structuralOpaqueIdSchema, structuralSha256Schema } from './iag-mutation-primitives.js';

export const IAG_RESULT_SCHEMA_VERSION = 'iag-internet-policy-result.v1' as const;
export const IAG_TERMINAL_OUTCOMES = [
  'DRY_RUN_COMPLETE',
  'NO_CHANGE_REQUIRED',
  'REFUSED',
  'SUCCEEDED',
  'FAILED_HALT',
  'INDETERMINATE',
] as const;

const commonResultShape = {
  schemaVersion: z.literal(IAG_RESULT_SCHEMA_VERSION),
  action: structuralIagMutationActionSchema,
  actionDigest: structuralSha256Schema,
  promotionEligible: z.literal(false),
} as const;

const noMutationSchema = z.object({ attempted: z.literal(false), count: z.literal(0) }).strict().readonly();
const oneMutationSchema = z.object({ attempted: z.literal(true), count: z.literal(1) }).strict().readonly();
const boundedMutationSchema = z.discriminatedUnion('attempted', [
  z.object({ attempted: z.literal(false), count: z.literal(0) }).strict(),
  z.object({ attempted: z.literal(true), count: z.literal(1) }).strict(),
]).readonly();

const dryRunCompleteSchema = z.object({
  ...commonResultShape,
  outcome: z.literal('DRY_RUN_COMPLETE'),
  mutation: noMutationSchema,
  verifiedSuccess: z.literal(false),
  finalReadBack: z.literal('NONE'),
}).strict();

const noChangeRequiredSchema = z.object({
  ...commonResultShape,
  outcome: z.literal('NO_CHANGE_REQUIRED'),
  mutation: noMutationSchema,
  verifiedSuccess: z.literal(true),
  finalReadBack: z.literal('MATCHED'),
  readBackProofDigest: structuralSha256Schema,
}).strict();

const refusedSchema = z.object({
  ...commonResultShape,
  outcome: z.literal('REFUSED'),
  mutation: noMutationSchema,
  verifiedSuccess: z.literal(false),
  finalReadBack: z.literal('NONE'),
  reasonCode: structuralOpaqueIdSchema,
}).strict();

const succeededSchema = z.object({
  ...commonResultShape,
  outcome: z.literal('SUCCEEDED'),
  mutation: oneMutationSchema,
  verifiedSuccess: z.literal(true),
  finalReadBack: z.literal('MATCHED'),
  readBackProofDigest: structuralSha256Schema,
}).strict();

const failedHaltSchema = z.object({
  ...commonResultShape,
  outcome: z.literal('FAILED_HALT'),
  mutation: boundedMutationSchema,
  verifiedSuccess: z.literal(false),
  finalReadBack: z.literal('MISMATCHED'),
  readBackProofDigest: structuralSha256Schema,
  reasonCode: structuralOpaqueIdSchema,
}).strict();

const indeterminateSchema = z.object({
  ...commonResultShape,
  outcome: z.literal('INDETERMINATE'),
  mutation: boundedMutationSchema,
  verifiedSuccess: z.literal(false),
  finalReadBack: z.enum(['INDETERMINATE', 'UNAVAILABLE']),
  readBackProofDigest: structuralSha256Schema.nullable(),
  reasonCode: structuralOpaqueIdSchema,
}).strict();

export const structuralIagMutationResultSchema = z.discriminatedUnion('outcome', [
  dryRunCompleteSchema,
  noChangeRequiredSchema,
  refusedSchema,
  succeededSchema,
  failedHaltSchema,
  indeterminateSchema,
]).readonly();

export type GroundedIagMutationResult = z.infer<typeof structuralIagMutationResultSchema>;
export type IagTerminalOutcome = (typeof IAG_TERMINAL_OUTCOMES)[number];
