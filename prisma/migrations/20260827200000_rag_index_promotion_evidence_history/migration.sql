-- Append-only, scope-bound authorization evidence for every RAG index promotion attempt accepted once.
CREATE TABLE IF NOT EXISTS "BlroRagIndexPromotionEvidence" (
  "tenantId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "nonce" TEXT NOT NULL CHECK (length("nonce")>=16),
  "cohortId" TEXT NOT NULL,
  "indexEpoch" INTEGER NOT NULL CHECK ("indexEpoch">=0),
  "authorityActorId" TEXT NOT NULL CHECK (length("authorityActorId")>0),
  "evidence" JSONB NOT NULL,
  "evidenceCanonical" TEXT NOT NULL CHECK (length("evidenceCanonical")>0),
  "reportDigest" TEXT NOT NULL CHECK ("reportDigest" ~ '^[a-f0-9]{64}$'),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BlroRagIndexPromotionEvidence_pkey" PRIMARY KEY ("tenantId","projectId","nonce"),
  CONSTRAINT "t24_tp_a92eee6394e6445f" FOREIGN KEY ("tenantId","projectId")
    REFERENCES "BlroProject"("tenantId","id") ON DELETE RESTRICT,
  CONSTRAINT "BlroRagIndexPromotionEvidence_cohort_fkey" FOREIGN KEY ("tenantId","projectId","cohortId")
    REFERENCES "BlroRagEmbeddingCohort"("tenantId","projectId","id") ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS "BlroRagIndexPromotionEvidence_scope_epoch_idx"
  ON "BlroRagIndexPromotionEvidence" ("tenantId","projectId","cohortId","indexEpoch");
INSERT INTO "BlroRagIndexPromotionEvidence"
  ("tenantId","projectId","nonce","cohortId","indexEpoch","authorityActorId","evidence","evidenceCanonical","reportDigest")
SELECT "tenantId","projectId","report"->>'nonce',"cohortId","indexEpoch",
  "report"->>'authorityActorId',"report","reportCanonical","reportDigest"
FROM "BlroRagIndexPromotion"
WHERE "report"->>'schemaVersion'='rag.index-promotion-evidence/1'
  AND length("report"->>'nonce')>=16 AND length("report"->>'authorityActorId')>0
ON CONFLICT ("tenantId","projectId","nonce") DO NOTHING;
ALTER TABLE "BlroRagIndexPromotionEvidence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BlroRagIndexPromotionEvidence" FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "BlroRagIndexPromotionEvidence_scope" ON "BlroRagIndexPromotionEvidence"
    USING ("projectId"=current_setting('app.project_id',true))
    WITH CHECK ("projectId"=current_setting('app.project_id',true));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
