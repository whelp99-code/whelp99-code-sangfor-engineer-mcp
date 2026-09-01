import { z } from 'zod';
import { runtimeJsonObjectSchema } from '../../shared/src/runtime-json-codecs.js';
import { parseRuntimeJson } from '../../shared/src/runtime-schema.js';

const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().max(16 * 1024 * 1024),
}).strict();

export type FineTuneDatasetLine = {
  readonly messages: readonly {
    readonly role: 'system' | 'user' | 'assistant';
    readonly content: string;
  }[];
  readonly metadata?: Record<string, unknown>;
};

export function parseBoundaryFinetuneDatasetLineV1(source: string): FineTuneDatasetLine {
  return parseRuntimeJson(source, {
    schema: z.object({
      messages: z.array(messageSchema).min(3).max(10_000),
      metadata: runtimeJsonObjectSchema.optional(),
    }).strict(),
    schemaName: 'finetune.dataset-line.v1',
    policy: 'deny',
  });
}
