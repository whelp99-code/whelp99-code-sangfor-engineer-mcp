-- A vector width and model label do not identify the transformation that
-- produced a vector. Persist the complete, canonical embedding-space contract.
-- Legacy rows are retained for audit but deactivated because their revision and
-- preprocessing cannot be reconstructed safely.
BEGIN;

ALTER TABLE "BlroRagEmbeddingCohort"
  ADD COLUMN IF NOT EXISTS "embeddingSpace" JSONB,
  ADD COLUMN IF NOT EXISTS "embeddingSpaceDigest" TEXT;

UPDATE "BlroRagEmbeddingCohort"
SET "active"=false
WHERE "embeddingSpace" IS NULL OR "embeddingSpaceDigest" IS NULL;

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
    OR ("embeddingSpace" IS NOT NULL AND "embeddingSpaceDigest" ~ '^[a-f0-9]{64}$')
  );

COMMIT;
