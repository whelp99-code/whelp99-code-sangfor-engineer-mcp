import { z } from 'zod';

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const UnmeasuredIndexPromotionQaReportSchema = z.object({
  schemaVersion: z.literal('rag.index-promotion-qa/2'),
  eligibility: z.literal('NOT_ELIGIBLE'),
  refusalReason: z.literal('RAG_INDEX_PROMOTION_QA_UPDATE_RECOVERY_UNMEASURED'),
  benchmarkDigest: DigestSchema,
  benchmarkQueryCount: z.number().int().positive(),
  recallAtK: z.number().finite().min(0).max(1),
  exactP95Ms: z.number().finite().nonnegative(),
  candidateP95Ms: z.number().finite().nonnegative(),
  scopeIsolationProof: z.boolean(),
  updateMeasured: z.literal(false),
  recoveryMeasured: z.literal(false),
  index: z.literal('BlroRagEmbedding_embedding_hnsw_idx'),
}).strict().readonly();

export type UnmeasuredIndexPromotionQaReport = z.infer<typeof UnmeasuredIndexPromotionQaReportSchema>;

type BuildInput = Omit<UnmeasuredIndexPromotionQaReport,
  'schemaVersion' | 'eligibility' | 'refusalReason' | 'updateMeasured' | 'recoveryMeasured'>;

export function buildUnmeasuredIndexPromotionQaReport(input: BuildInput): UnmeasuredIndexPromotionQaReport {
  return UnmeasuredIndexPromotionQaReportSchema.parse({
    schemaVersion: 'rag.index-promotion-qa/2',
    eligibility: 'NOT_ELIGIBLE',
    refusalReason: 'RAG_INDEX_PROMOTION_QA_UPDATE_RECOVERY_UNMEASURED',
    updateMeasured: false,
    recoveryMeasured: false,
    ...input,
  });
}
