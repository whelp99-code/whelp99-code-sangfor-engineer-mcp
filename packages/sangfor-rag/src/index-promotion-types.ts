import { z } from 'zod';
import type { PgvectorHit, PgvectorScope, PgvectorSearch } from './pgvector-types.js';

export const INDEX_PROMOTION_SCHEMA_VERSION = 'rag.index-promotion/1' as const;
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const NonemptySchema = z.string().min(1);

const IndexPromotionReportInputObjectSchema = z.object({
  schemaVersion: z.literal(INDEX_PROMOTION_SCHEMA_VERSION),
  tenantId: NonemptySchema,
  projectId: NonemptySchema,
  cohortId: NonemptySchema,
  indexEpoch: z.number().int().nonnegative(),
  corpusDigest: DigestSchema,
  exactResultDigest: DigestSchema,
  candidateResultDigest: DigestSchema,
  extensionName: NonemptySchema,
  extensionVersion: NonemptySchema,
  indexName: NonemptySchema,
  indexIdentity: DigestSchema,
  measuredAt: z.string().datetime(),
  maxAgeSeconds: z.number().int().positive(),
  recallAtK: z.number().finite().min(0).max(1),
  exactP95Ms: z.number().finite().nonnegative(),
  candidateP95Ms: z.number().finite().nonnegative(),
  recoveryRate: z.number().finite().min(0).max(1),
  updateRate: z.number().finite().min(0).max(1),
  scopeIsolationProof: z.boolean(),
  candidateRowCount: z.number().int().nonnegative(),
}).strict();
export const IndexPromotionReportInputSchema = IndexPromotionReportInputObjectSchema.readonly();

export const IndexPromotionReportSchema = IndexPromotionReportInputObjectSchema.extend({
  reportDigest: DigestSchema,
}).strict().readonly();

export const HnswIndexIdentitySchema = z.object({
  oid: z.string().regex(/^\d+$/u),
  relfilenode: z.string().regex(/^\d+$/u),
  definitionDigest: DigestSchema,
  name: z.literal('BlroRagEmbedding_embedding_hnsw_idx'),
  tableName: z.literal('BlroRagEmbedding'),
  operatorClass: z.literal('vector_cosine_ops'),
  valid: z.literal(true),
  ready: z.literal(true),
}).strict().readonly();

export const PromotionCurrentStateSchema = z.object({
  tenantId: NonemptySchema,
  projectId: NonemptySchema,
  cohortId: NonemptySchema,
  indexEpoch: z.number().int().nonnegative(),
  corpusDigest: DigestSchema,
  extensionName: z.literal('vector'),
  extensionVersion: z.literal('0.8.1'),
  indexName: NonemptySchema,
  indexIdentity: DigestSchema,
  candidateRowCount: z.number().int().nonnegative(),
}).strict().readonly();

export type HnswIndexIdentity = z.infer<typeof HnswIndexIdentitySchema>;
export type IndexPromotionReportInput = z.infer<typeof IndexPromotionReportInputSchema>;
export type IndexPromotionReport = z.infer<typeof IndexPromotionReportSchema>;
export type PromotionCurrentState = z.infer<typeof PromotionCurrentStateSchema>;
export type PromotionEvaluation =
  | { readonly eligible: true; readonly reason: 'PROMOTION_ELIGIBLE' }
  | { readonly eligible: false; readonly reason: string };

export type PromotionSearchOptions = {
  readonly backend: 'auto' | 'exact';
  readonly now: Date;
  readonly beforeCandidateDispatch?: () => Promise<void>;
};

export type PromotionSearchResult = {
  readonly backend: 'exact' | 'hnsw';
  readonly hits: readonly PgvectorHit[];
  readonly diagnostics: {
    readonly reason: string;
    readonly reportDigest?: string;
  };
};

export interface PromotionSearchPort {
  loadPromotion(scope: PgvectorScope): Promise<unknown | null>;
  readCurrentState(scope: PgvectorScope): Promise<unknown>;
  preflightCandidate(scope: PgvectorScope, indexName: string): Promise<HnswIndexIdentity | null>;
  searchExact(input: PgvectorSearch): Promise<unknown>;
  searchCandidate(input: PgvectorSearch, expectedIdentity: HnswIndexIdentity): Promise<unknown>;
}
