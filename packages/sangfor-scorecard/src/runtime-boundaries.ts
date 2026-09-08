import { z } from 'zod';
import { runtimeJsonObjectSchema } from '../../shared/src/runtime-json-codecs.js';
import {
  parseRuntimeJson,
  type NamedRuntimeCodec,
  type RuntimeCodec,
} from '../../shared/src/runtime-schema.js';
import type { HumanActionEntry, ShadowRunEntry } from './shadow.js';
import type { TimeSavedEntry } from './time-saved.js';

const idSchema = z.string().min(1).max(512);
const timestampSchema = z.string().min(1).max(128);
export const shadowRunCodec: NamedRuntimeCodec<ShadowRunEntry> = {
  schema: z.object({
    id: idSchema,
    kind: z.literal('shadow-run'),
    automationId: idSchema,
    findingId: idSchema,
    automatedAction: runtimeJsonObjectSchema,
    at: timestampSchema,
  }).strict(),
  schemaName: 'scorecard.shadow-run.v1',
};
export const humanActionCodec: NamedRuntimeCodec<HumanActionEntry> = {
  schema: z.object({
    id: idSchema,
    kind: z.literal('human-action'),
    automationId: idSchema,
    findingId: idSchema,
    humanAction: runtimeJsonObjectSchema,
    at: timestampSchema,
  }).strict(),
  schemaName: 'scorecard.human-action.v1',
};
const timeSavedSchema: RuntimeCodec<TimeSavedEntry> = z.object({
  id: idSchema,
  kind: z.enum(['auto-closed-finding', 'dossier-assembled', 'report-generated']),
  findingId: idSchema.optional(),
  estimateMinutes: z.number().finite().nonnegative(),
  basis: idSchema,
  at: timestampSchema,
}).strict();

export function parseBoundaryShadowLedgerLineV1<TOutput, TInput>(
  source: string,
  codec: NamedRuntimeCodec<TOutput, TInput>,
): TOutput {
  return parseRuntimeJson(source, {
    ...codec,
    schemaName: 'scorecard.shadow-ledger-line.v1',
    policy: 'invalid_report',
  });
}

export function parseBoundaryTimeSavedLineV1(source: string): TimeSavedEntry {
  return parseRuntimeJson(source, {
    schema: timeSavedSchema,
    schemaName: 'scorecard.time-saved-line.v1',
    policy: 'invalid_report',
  });
}
