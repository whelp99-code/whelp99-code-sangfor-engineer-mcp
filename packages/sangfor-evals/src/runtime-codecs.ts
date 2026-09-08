import { z } from 'zod';
import type { NamedRuntimeCodec } from '../../shared/src/runtime-schema.js';
import type { EvalCase } from './index.js';

const textSchema = z.string().min(1).max(1_000_000);

export const evalCaseCodec: NamedRuntimeCodec<EvalCase> = {
  schema: z.object({
    id: z.string().min(1).max(512),
    name: textSchema,
    product: z.string().min(1).max(512),
    requiredText: textSchema,
  }).strict(),
  schemaName: 'evals.case.v1',
};
