-- A vector width and model label do not identify the transformation that
-- produced a vector. Persist the complete, canonical embedding-space contract.
-- Legacy rows are retained for audit but deactivated because their revision and
-- preprocessing cannot be reconstructed safely.
BEGIN;

ALTER TABLE "BlroRagEmbeddingCohort"
  ADD COLUMN IF NOT EXISTS "embeddingSpace" JSONB,
  ADD COLUMN IF NOT EXISTS "embeddingSpaceDigest" TEXT;

-- The migration role owns these tables. Keep RLS enabled while temporarily
-- removing FORCE so this administrative repair cannot be filtered by a stale
-- or absent app.project_id setting.
ALTER TABLE "BlroRagEmbeddingCohort" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "BlroRagIndexPromotion" NO FORCE ROW LEVEL SECURITY;

UPDATE "BlroRagEmbeddingCohort"
SET "active"=false
WHERE "embeddingSpace" IS NULL OR "embeddingSpaceDigest" IS NULL;

-- Promotion envelopes written before this contract cannot prove an embedding
-- space, benchmark profile, or measured update/recovery checks. Retain them for
-- audit, but remove routing authority. Runtime signature verification still
-- applies to structurally compatible envelopes that remain promoted.
UPDATE "BlroRagIndexPromotion"
SET "state"='demoted',
    "reason"='embedding-space-contract-migration',
    "demotedAt"=CURRENT_TIMESTAMP,
    "updatedAt"=CURRENT_TIMESTAMP
WHERE "state"='promoted'
  AND (
    jsonb_typeof("report")='object'
    AND "report"->>'schemaVersion'='rag.index-promotion-evidence/1'
    AND jsonb_typeof("report"->'report')='object'
    AND "report"->'report'->>'schemaVersion'='rag.index-promotion/1'
    AND "report"->'report'->>'embeddingSpaceDigest' ~ '^[a-f0-9]{64}$'
    AND "report"->'report'->>'benchmarkDigest' ~ '^[a-f0-9]{64}$'
    AND "report"->'report'->>'benchmarkProfileDigest' ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof("report"->'report'->'benchmarkQueryCount')='number'
    AND jsonb_typeof("report"->'report'->'k')='number'
    AND "report"->'report'->'updateMeasured'='true'::jsonb
    AND "report"->'report'->'recoveryMeasured'='true'::jsonb
  ) IS NOT TRUE;

ALTER TABLE "BlroRagEmbeddingCohort"
  DROP CONSTRAINT IF EXISTS "BlroRagEmbeddingCohort_identity_key";

CREATE UNIQUE INDEX IF NOT EXISTS "BlroRagEmbeddingCohort_full_space_identity_key"
  ON "BlroRagEmbeddingCohort"
    ("tenantId","projectId","indexEpoch","backend","model","dimensions","embeddingSpaceDigest")
  WHERE "embeddingSpace" IS NOT NULL AND "embeddingSpaceDigest" IS NOT NULL;

ALTER TABLE "BlroRagEmbeddingCohort"
  DROP CONSTRAINT IF EXISTS "BlroRagEmbeddingCohort_embedding_space_pair";
ALTER TABLE "BlroRagEmbeddingCohort"
  ADD CONSTRAINT "BlroRagEmbeddingCohort_embedding_space_pair" CHECK (
    ("embeddingSpace" IS NULL AND "embeddingSpaceDigest" IS NULL)
    OR ("embeddingSpace" IS NOT NULL AND "embeddingSpaceDigest" IS NOT NULL
      AND "embeddingSpaceDigest" ~ '^[a-f0-9]{64}$')
  );

ALTER TABLE "BlroRagIndexPromotion" FORCE ROW LEVEL SECURITY;
ALTER TABLE "BlroRagEmbeddingCohort" FORCE ROW LEVEL SECURITY;

COMMIT;
