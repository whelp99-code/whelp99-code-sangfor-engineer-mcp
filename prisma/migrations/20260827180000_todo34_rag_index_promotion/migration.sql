-- Todo 34: persisted, project-scoped HNSW promotion authority.
CREATE TABLE "BlroRagIndexPromotion" (
  "tenantId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "cohortId" TEXT NOT NULL,
  "indexEpoch" INTEGER NOT NULL CHECK ("indexEpoch">=0),
  "report" JSONB NOT NULL,
  "reportCanonical" TEXT NOT NULL CHECK (length("reportCanonical")>0),
  "reportDigest" TEXT NOT NULL CHECK ("reportDigest" ~ '^[a-f0-9]{64}$'),
  "state" TEXT NOT NULL CHECK ("state" IN ('promoted','demoted')),
  "reason" TEXT NOT NULL CHECK (length("reason")>0),
  "promotedAt" TIMESTAMPTZ(3),
  "demotedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BlroRagIndexPromotion_pkey" PRIMARY KEY ("tenantId","projectId","cohortId","indexEpoch"),
  CONSTRAINT "t24_tp_f7cf370756fbb7a9" FOREIGN KEY ("tenantId","projectId")
    REFERENCES "BlroProject"("tenantId","id") ON DELETE RESTRICT,
  CONSTRAINT "BlroRagIndexPromotion_cohort_fkey" FOREIGN KEY ("tenantId","projectId","cohortId")
    REFERENCES "BlroRagEmbeddingCohort"("tenantId","projectId","id") ON DELETE RESTRICT,
  CONSTRAINT "BlroRagIndexPromotion_state_timestamps" CHECK (
    ("state"='promoted' AND "promotedAt" IS NOT NULL AND "demotedAt" IS NULL)
    OR ("state"='demoted' AND "demotedAt" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "BlroRagIndexPromotion_one_promoted_scope_key"
  ON "BlroRagIndexPromotion" ("tenantId","projectId") WHERE "state"='promoted';
CREATE INDEX "BlroRagIndexPromotion_scope_cohort_epoch_idx"
  ON "BlroRagIndexPromotion" ("tenantId","projectId","cohortId","indexEpoch");
ALTER TABLE "BlroRagIndexPromotion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BlroRagIndexPromotion" FORCE ROW LEVEL SECURITY;
CREATE POLICY "BlroRagIndexPromotion_scope" ON "BlroRagIndexPromotion"
  USING ("projectId"=current_setting('app.project_id',true))
  WITH CHECK ("projectId"=current_setting('app.project_id',true));
