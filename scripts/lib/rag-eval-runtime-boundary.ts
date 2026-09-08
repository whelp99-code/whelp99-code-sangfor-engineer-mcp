import { z } from 'zod';
import { parseRuntimeJson, type RuntimeCodec } from '../../packages/shared/src/runtime-schema.js';
import type { RetrievalQrel, RetrievalRunHit } from '../../packages/sangfor-rag/src/retrieval-eval.js';

export type RagEvalInput = {
  readonly qrels: RetrievalQrel[];
  readonly run: RetrievalRunHit[];
  readonly k?: number;
  readonly metadata?: Record<string, string>;
};

const idSchema = z.string().min(1).max(512);
const qrelSchema: RuntimeCodec<RetrievalQrel> = z.object({
  queryId: idSchema,
  sourceId: idSchema,
  grade: z.number().finite().nonnegative(),
}).strict();
const runHitSchema: RuntimeCodec<RetrievalRunHit> = z.object({
  queryId: idSchema,
  sourceId: idSchema,
  rank: z.number().int().positive(),
  score: z.number().finite(),
}).strict();
const evalInputSchema: RuntimeCodec<RagEvalInput> = z.object({
  qrels: z.array(qrelSchema).max(1_000_000),
  run: z.array(runHitSchema).max(1_000_000),
  k: z.number().int().positive().max(1_000_000).optional(),
  metadata: z.record(z.string().min(1).max(512), z.string().max(16_384)).optional(),
}).strict();

export function parseBoundaryRagEvalInputV1(source: string): RagEvalInput {
  return parseRuntimeJson(source, {
    schema: evalInputSchema,
    schemaName: 'rag-operations.eval-input.v1',
    policy: 'loud_failure',
  });
}
