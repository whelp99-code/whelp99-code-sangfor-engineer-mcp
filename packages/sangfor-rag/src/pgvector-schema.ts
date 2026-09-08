import { z } from 'zod';
import {
  PgvectorCohortSchema,
  PgvectorScopeSchema,
  PgvectorSearchSchema,
  PgvectorUpsertSchema,
  type PgvectorCohort,
  type PgvectorScope,
  type PgvectorSearch,
  type PgvectorUpsert,
} from './pgvector-types.js';

export class RagPgvectorRefusal extends Error {
  readonly name = 'RagPgvectorRefusal';
  constructor(readonly code: string, detail: string, options?: ErrorOptions) {
    super(`${code}: ${detail}`, options);
  }
}

export class RagPgvectorUnavailableError extends Error {
  readonly name = 'RagPgvectorUnavailableError';
  constructor(readonly code: string, options?: ErrorOptions) {
    super(code, options);
  }
}

function parse<Schema extends z.ZodTypeAny>(schema: Schema, input: unknown, code: string): z.output<Schema> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new RagPgvectorRefusal(code, result.error.issues.map((issue) => issue.path.join('.')).join(', '), { cause: result.error });
  }
  return result.data;
}

export function parsePgvectorScope(input: unknown): PgvectorScope {
  return parse(PgvectorScopeSchema, input, 'RAG_PGVECTOR_SCOPE_INVALID');
}

export function parsePgvectorCohort(input: unknown): PgvectorCohort {
  return parse(PgvectorCohortSchema, input, 'RAG_PGVECTOR_COHORT_INVALID');
}

export function parsePgvectorUpsert(input: unknown): PgvectorUpsert {
  return parse(PgvectorUpsertSchema, input, 'RAG_PGVECTOR_CHUNK_INVALID');
}

export function parsePgvectorSearch(input: unknown): PgvectorSearch {
  return parse(PgvectorSearchSchema, input, 'RAG_PGVECTOR_SEARCH_INVALID');
}
