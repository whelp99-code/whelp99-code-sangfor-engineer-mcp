import type { PrismaClient } from '@prisma/client';
import { sealIndexPromotionEvidence } from '../../packages/sangfor-rag/src/index-promotion-authority.js';
import { sealIndexPromotionReport } from '../../packages/sangfor-rag/src/index-promotion-evaluator.js';
import { IndexPromotionStore } from '../../packages/sangfor-rag/src/index-promotion-store.js';
import type { PgvectorScope } from '../../packages/sangfor-rag/src/pgvector-types.js';

type PromotionFixtureInput = {
  readonly promotion: IndexPromotionStore;
  readonly scope: PgvectorScope;
  readonly authority: { readonly actorId: string; readonly secret: string };
  readonly nonce: string;
};

export async function promotionFixture(input: PromotionFixtureInput) {
  const state = await input.promotion.readCurrentState(input.scope);
  const now = new Date();
  const report = sealIndexPromotionReport({
    schemaVersion: 'rag.index-promotion/1', ...state, exactResultDigest: 'a'.repeat(64),
    candidateResultDigest: 'b'.repeat(64), measuredAt: now.toISOString(), maxAgeSeconds: 3600,
    recallAtK: 0.99, exactP95Ms: 200, candidateP95Ms: 150, recoveryRate: 1, updateRate: 1,
    scopeIsolationProof: true, candidateRowCount: state.candidateRowCount,
  });
  return { now, report, evidence: sealIndexPromotionEvidence({
    report, authorityActorId: input.authority.actorId, nonce: input.nonce, secret: input.authority.secret,
  }) };
}

export async function createHnsw(owner: PrismaClient): Promise<void> {
  await owner.$executeRawUnsafe(`CREATE INDEX "BlroRagEmbedding_embedding_hnsw_idx" ON "BlroRagEmbedding" USING hnsw ("embedding" vector_cosine_ops) WITH (m=16,ef_construction=1000)`);
}
