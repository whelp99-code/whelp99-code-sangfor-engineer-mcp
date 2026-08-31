import { z } from 'zod';
import { runtimeJsonObjectSchema, runtimeJsonValueSchema } from '../../shared/src/runtime-json-codecs.js';
import { parseRuntimeJson, type RuntimeCodec } from '../../shared/src/runtime-schema.js';
import type { RunRecord } from './run-store.js';

const idSchema = z.string().min(1).max(512);
const textSchema = z.string().max(16 * 1024 * 1024);
const runRecordSchema: RuntimeCodec<RunRecord> = z.object({
  schemaVersion: z.literal(1),
  runId: idSchema,
  toolId: idSchema,
  toolSafety: z.enum(['read_only', 'write', 'destructive']),
  args: runtimeJsonObjectSchema,
  status: z.enum(['pending_approval', 'rejected', 'running', 'succeeded', 'failed']),
  requestedAt: z.string().min(1).max(128),
  finishedAt: z.string().max(128).optional(),
  durationMs: z.number().finite().nonnegative().optional(),
  resultSummary: textSchema.optional(),
  resultJson: runtimeJsonValueSchema.optional(),
  error: textSchema.optional(),
  deviceId: idSchema.optional(),
  sweepId: idSchema.optional(),
  approval: z.object({
    approvedBy: idSchema,
    approvedAt: z.string().min(1).max(128),
    changeTicketId: idSchema,
    rollbackPlanId: idSchema,
    authorityEpoch: z.number().int().nonnegative(),
  }).strict().optional(),
  rejectedReason: textSchema.optional(),
  playbookId: idSchema.optional(),
  playbookRunId: idSchema.optional(),
  playbookRev: z.number().int().nonnegative().optional(),
  blockId: idSchema.optional(),
}).strict();

export function parseBoundaryRunRecordLineV1(source: string): RunRecord {
  return parseRuntimeJson(source, {
    schema: runRecordSchema,
    schemaName: 'runs.record-line.v1',
    policy: 'freeze',
    expectedVersion: 1,
    versionPath: ['schemaVersion'],
  });
}
