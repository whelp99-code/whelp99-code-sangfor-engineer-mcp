import { z } from 'zod';

export const PGVECTOR_DIMENSIONS = 384 as const;

const PgvectorScopeObjectSchema = z.object({
  tenantId: z.string().min(1).brand('TenantId'),
  projectId: z.string().min(1).brand('ProjectId'),
  actorId: z.string().min(1).brand('ActorId'),
}).strict();
export const PgvectorScopeSchema = PgvectorScopeObjectSchema.readonly();

export const PgvectorCohortSchema = PgvectorScopeObjectSchema.extend({
  id: z.string().min(1).brand('RagCohortId'),
  indexEpoch: z.number().int().nonnegative(),
  backend: z.string().min(1),
  model: z.string().min(1),
  dimensions: z.literal(PGVECTOR_DIMENSIONS),
}).strict().readonly();

export const PgvectorFiltersSchema = z.object({
  product: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
  sourceType: z.string().min(1).optional(),
  trustLevel: z.string().min(1).optional(),
}).strict().readonly();

export const PgvectorUpsertSchema = PgvectorScopeObjectSchema.extend({
  cohortId: z.string().min(1).brand('RagCohortId'),
  id: z.string().min(1).brand('RagChunkId'),
  product: z.string().min(1),
  version: z.string().min(1),
  sourceType: z.string().min(1),
  trustLevel: z.string().min(1),
  title: z.string().min(1),
  text: z.string().min(1),
  sourceRef: z.string().min(1),
  contentHash: z.string().min(1),
  aclActorIds: z.array(z.string().min(1).brand('ActorId')).readonly(),
  embedding: z.array(z.number().finite()).length(PGVECTOR_DIMENSIONS).readonly(),
}).strict().readonly();

export const PgvectorSearchSchema = z.object({
  scope: PgvectorScopeSchema,
  query: z.array(z.number().finite()).length(PGVECTOR_DIMENSIONS).readonly(),
  filters: PgvectorFiltersSchema,
  limit: z.number().int().positive().max(100),
}).strict().readonly();

export const PgvectorHitRowSchema = z.object({
  id: z.string(),
  text: z.string(),
  title: z.string(),
  sourceRef: z.string(),
  distance: z.union([z.number(), z.string()]).transform(Number).pipe(z.number().finite()),
}).strict().readonly();

export type PgvectorScope = z.infer<typeof PgvectorScopeSchema>;
export type PgvectorCohort = z.infer<typeof PgvectorCohortSchema>;
export type PgvectorUpsert = z.infer<typeof PgvectorUpsertSchema>;
export type PgvectorSearch = z.infer<typeof PgvectorSearchSchema>;
export type PgvectorHit = z.infer<typeof PgvectorHitRowSchema>;

export interface PgvectorSqlExecutor {
  $executeRawUnsafe(query: string, ...values: readonly unknown[]): Promise<number>;
  $queryRawUnsafe<T>(query: string, ...values: readonly unknown[]): Promise<T>;
}

export interface PgvectorDatabase extends PgvectorSqlExecutor {
  $transaction<T>(operation: (transaction: PgvectorSqlExecutor) => Promise<T>, options?: { readonly isolationLevel?: 'ReadCommitted' | 'Serializable' }): Promise<T>;
}
