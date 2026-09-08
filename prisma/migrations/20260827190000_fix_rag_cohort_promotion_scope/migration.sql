-- Serialize and constrain active RAG cohorts by tenant/project scope, not epoch.
-- Existing databases may already contain one active row per epoch. Keep the
-- newest cohort active deterministically before installing the corrected key.
BEGIN;

ALTER TABLE "BlroRagEmbeddingCohort" DISABLE ROW LEVEL SECURITY;

WITH ranked_active AS (
  SELECT "tenantId", "projectId", "id",
    row_number() OVER (
      PARTITION BY "tenantId", "projectId"
      ORDER BY "indexEpoch" DESC, "createdAt" DESC, "id"
    ) AS active_rank
  FROM "BlroRagEmbeddingCohort"
  WHERE "active"=true
)
UPDATE "BlroRagEmbeddingCohort" cohort
SET "active"=false
FROM ranked_active ranked
WHERE cohort."tenantId"=ranked."tenantId"
  AND cohort."projectId"=ranked."projectId"
  AND cohort."id"=ranked."id"
  AND ranked.active_rank>1;

DROP INDEX IF EXISTS "BlroRagEmbeddingCohort_one_active_epoch_key";
CREATE UNIQUE INDEX IF NOT EXISTS "BlroRagEmbeddingCohort_one_active_scope_key"
  ON "BlroRagEmbeddingCohort" ("tenantId","projectId") WHERE "active";

-- The original ef_construction=64 graph loses recall after the atomic corpus
-- replacement workload. Rebuild once at the stronger construction quality;
-- runtime ef_search remains unchanged at the measured 0.99 recall gate.
ALTER INDEX "BlroRagEmbedding_embedding_hnsw_idx" SET (ef_construction=1000);
REINDEX INDEX "BlroRagEmbedding_embedding_hnsw_idx";

ALTER TABLE "BlroRagEmbeddingCohort" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BlroRagEmbeddingCohort" FORCE ROW LEVEL SECURITY;

COMMIT;
