import { Buffer } from 'node:buffer';
import { z } from 'zod';
import {
  RuntimeSchemaError,
  parseRuntimeJson,
  type RuntimeSchemaIssueCode,
} from '../../../shared/src/runtime-schema.js';

export const MAX_IAG_MUTATION_JSON_BYTES = 16_384 as const;
export const MAX_IAG_MUTATION_JSON_DEPTH = 8 as const;

export type IagMutationRefusalCode = RuntimeSchemaIssueCode
  | 'payload_too_large'
  | 'action_authority_refused'
  | 'readback_authority_refused'
  | 'result_authority_refused';

export type IagMutationRefusal = {
  readonly code: IagMutationRefusalCode;
  readonly path: readonly (string | number)[];
};

export type IagMutationParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: IagMutationRefusal };

export function refused(code: IagMutationRefusalCode, path: readonly (string | number)[] = []): IagMutationParseResult<never> {
  return { ok: false, refusal: { code, path } };
}

export function parseStructuralJson<TOutput, TInput>(input: {
  readonly source: string;
  readonly schema: z.ZodType<TOutput, z.ZodTypeDef, TInput>;
  readonly schemaName: string;
}): IagMutationParseResult<TOutput> {
  if (Buffer.byteLength(input.source, 'utf8') > MAX_IAG_MUTATION_JSON_BYTES) {
    return refused('payload_too_large');
  }
  try {
    return {
      ok: true,
      value: parseRuntimeJson(input.source, {
        schema: input.schema,
        schemaName: input.schemaName,
        policy: 'deny',
        maxDepth: MAX_IAG_MUTATION_JSON_DEPTH,
      }),
    };
  } catch (error) {
    if (!(error instanceof RuntimeSchemaError)) throw error;
    return { ok: false, refusal: error.issues[0] ?? { code: 'schema_mismatch', path: [] } };
  }
}
