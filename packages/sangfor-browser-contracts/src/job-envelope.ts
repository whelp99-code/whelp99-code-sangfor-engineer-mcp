import { z } from 'zod';
import {
  artifactRefSchema,
  browserExecutionRequestSchema,
  browserOperationStatusSchema,
  jsonValueSchema,
} from './browser-execution.js';

export const JOB_ENVELOPE_VERSION = 'browser-job-envelope.v1' as const;
export const JOB_RECEIPT_VERSION = 'browser-job-receipt.v1' as const;

const opaqueEnvelopeValueSchema = z.string()
  .trim()
  .min(1)
  .max(4096)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:@+=-]*$/,
    'Opaque value must not contain path separators or whitespace.',
  )
  .refine(
    (value) => !value.includes('..'),
    'Opaque value must not contain path traversal segments.',
  );

const capabilitySchema = z.string()
  .trim()
  .min(1)
  .max(8192)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:@+=-]*$/u,
    'Capability must be opaque transport data without paths or whitespace.',
  )
  .refine(
    (value) => !value.includes('..'),
    'Capability must not contain path traversal segments.',
  );

const timestampSchema = z.string().datetime({ offset: true });

export const jobEnvelopeSchema = z.object({
  schemaVersion: z.literal(JOB_ENVELOPE_VERSION),
  jobId: opaqueEnvelopeValueSchema,
  tenantId: opaqueEnvelopeValueSchema,
  projectId: opaqueEnvelopeValueSchema,
  runId: opaqueEnvelopeValueSchema,
  stepId: opaqueEnvelopeValueSchema,
  issuedAt: timestampSchema,
  expiresAt: timestampSchema,
  capability: capabilitySchema,
  request: browserExecutionRequestSchema,
}).strict().superRefine((envelope, context) => {
  if (Date.parse(envelope.expiresAt) <= Date.parse(envelope.issuedAt)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['expiresAt'],
      message: 'Job envelope expiresAt must be after issuedAt.',
    });
  }
}).readonly();

export const jobReceiptSchema = z.object({
  schemaVersion: z.literal(JOB_RECEIPT_VERSION),
  jobId: opaqueEnvelopeValueSchema,
  acceptedAt: timestampSchema,
  status: browserOperationStatusSchema,
  observations: z.record(jsonValueSchema),
  mutationAttempted: z.boolean(),
  evidenceRefs: z.array(artifactRefSchema),
}).strict().readonly();

export type JobEnvelope = z.infer<typeof jobEnvelopeSchema>;
export type JobReceipt = z.infer<typeof jobReceiptSchema>;

export function parseJobEnvelope(input: unknown, now: Date = new Date()): JobEnvelope {
  const envelope = jobEnvelopeSchema.parse(input);
  if (Date.parse(envelope.expiresAt) <= now.getTime()) {
    throw new z.ZodError([{
      code: z.ZodIssueCode.custom,
      path: ['expiresAt'],
      message: 'Job envelope has expired.',
    }]);
  }
  return envelope;
}
