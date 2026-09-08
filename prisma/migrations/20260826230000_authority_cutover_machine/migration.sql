-- Todo 23: durable project+aggregate cutover state. PostgreSQL is the only
-- coordination authority; state, fence, epoch, and checkpoint commit together.
CREATE TABLE "BlroAuthorityCutover" (
  "projectId" TEXT NOT NULL,
  "aggregate" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'LOCAL_PRIMARY',
  "epoch" INTEGER NOT NULL DEFAULT 0,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "sourceHighWaterMark" TEXT,
  "sourceDigest" TEXT,
  "targetDigest" TEXT,
  "localWriteFencedAt" TIMESTAMPTZ(3),
  "sourceOwnerTenantId" TEXT,
  "sourceRoot" TEXT,
  "sourceDevice" TEXT,
  "sourceInode" TEXT,
  "sourceMarkerRequired" BOOLEAN NOT NULL DEFAULT false,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BlroAuthorityCutover_pkey" PRIMARY KEY ("projectId", "aggregate"),
  CONSTRAINT "BlroAuthorityCutover_projectId_fkey" FOREIGN KEY ("projectId")
    REFERENCES "BlroProject"("id") ON DELETE RESTRICT,
  CONSTRAINT "BlroAuthorityCutover_state_check" CHECK ("state" IN (
    'LOCAL_PRIMARY','BACKFILLING','SHADOW_READING','FROZEN','POSTGRES_PRIMARY'
  )),
  CONSTRAINT "BlroAuthorityCutover_epoch_check" CHECK ("epoch" >= 0),
  CONSTRAINT "BlroAuthorityCutover_revision_check" CHECK ("revision" >= 0),
  CONSTRAINT "BlroAuthorityCutover_source_claim_check" CHECK (("sourceRoot" IS NULL AND "sourceDevice" IS NULL AND "sourceInode" IS NULL AND "sourceOwnerTenantId" IS NULL) OR ("sourceRoot" IS NOT NULL AND "sourceDevice" IS NOT NULL AND "sourceInode" IS NOT NULL AND "sourceOwnerTenantId" IS NOT NULL)),
  CONSTRAINT "BlroAuthorityCutover_fence_check" CHECK (
    ("state" IN ('LOCAL_PRIMARY','BACKFILLING','SHADOW_READING') AND "localWriteFencedAt" IS NULL)
    OR ("state" IN ('FROZEN','POSTGRES_PRIMARY') AND "localWriteFencedAt" IS NOT NULL)
  )
);
CREATE TABLE "BlroSourceRootOwner" (
  "sourceDevice" TEXT NOT NULL, "sourceInode" TEXT NOT NULL, "tenantId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL, "sourceRoot" TEXT NOT NULL, "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BlroSourceRootOwner_pkey" PRIMARY KEY ("sourceDevice","sourceInode"),
  CONSTRAINT "BlroSourceRootOwner_project_fkey" FOREIGN KEY ("projectId") REFERENCES "BlroProject"("id") ON DELETE CASCADE
);

CREATE TABLE "BlroProjectAuthorityEpoch" (
  "projectId" TEXT NOT NULL,
  "epoch" INTEGER NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BlroProjectAuthorityEpoch_pkey" PRIMARY KEY ("projectId"),
  CONSTRAINT "BlroProjectAuthorityEpoch_project_fkey" FOREIGN KEY ("projectId") REFERENCES "BlroProject"("id") ON DELETE CASCADE,
  CONSTRAINT "BlroProjectAuthorityEpoch_epoch_check" CHECK ("epoch" >= 0)
);

CREATE TABLE "BlroLocalWriteIntent" (
  "writeId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "aggregate" TEXT NOT NULL,
  "epoch" INTEGER NOT NULL,
  "sourceRoot" TEXT NOT NULL,
  "operationDigest" TEXT NOT NULL,
  "targetPaths" JSONB NOT NULL,
  "beforeDigests" JSONB NOT NULL,
  "afterDigests" JSONB,
  "status" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMPTZ(3),
  CONSTRAINT "BlroLocalWriteIntent_pkey" PRIMARY KEY ("writeId"),
  CONSTRAINT "BlroLocalWriteIntent_tenant_fkey" FOREIGN KEY ("tenantId") REFERENCES "BlroTenant"("id") ON DELETE RESTRICT,
  CONSTRAINT "BlroLocalWriteIntent_actor_fkey" FOREIGN KEY ("actorId") REFERENCES "BlroActor"("id") ON DELETE RESTRICT,
  CONSTRAINT "BlroLocalWriteIntent_cutover_fkey" FOREIGN KEY ("projectId", "aggregate") REFERENCES "BlroAuthorityCutover"("projectId", "aggregate") ON DELETE RESTRICT,
  CONSTRAINT "BlroLocalWriteIntent_status_check" CHECK ("status" IN ('PENDING','COMPLETED','ABORTED')),
  CONSTRAINT "BlroLocalWriteIntent_resolution_check" CHECK (("status"='PENDING' AND "resolvedAt" IS NULL AND "afterDigests" IS NULL) OR ("status"<>'PENDING' AND "resolvedAt" IS NOT NULL AND "afterDigests" IS NOT NULL))
);
CREATE INDEX "BlroLocalWriteIntent_pending_idx" ON "BlroLocalWriteIntent"("projectId","aggregate","status");

-- Staging is checkpoint-owned migration data, never an application authority.
CREATE TABLE "BlroAuthorityCutoverStaging" (
  "projectId" TEXT NOT NULL,
  "aggregate" TEXT NOT NULL,
  "recordKey" TEXT NOT NULL,
  "highWaterMark" TEXT NOT NULL,
  "record" JSONB NOT NULL,
  "recordDigest" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BlroAuthorityCutoverStaging_pkey" PRIMARY KEY ("projectId", "aggregate", "recordKey"),
  CONSTRAINT "BlroAuthorityCutoverStaging_cutover_fkey" FOREIGN KEY ("projectId", "aggregate")
    REFERENCES "BlroAuthorityCutover"("projectId", "aggregate") ON DELETE CASCADE
);
CREATE INDEX "BlroAuthorityCutoverStaging_checkpoint_idx"
  ON "BlroAuthorityCutoverStaging"("projectId", "aggregate", "highWaterMark");

ALTER TABLE "BlroSourceRootOwner" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BlroSourceRootOwner" FORCE ROW LEVEL SECURITY;
CREATE POLICY "BlroSourceRootOwner_scope" ON "BlroSourceRootOwner"
  USING ("projectId" = current_setting('app.project_id', true))
  WITH CHECK ("projectId" = current_setting('app.project_id', true));
ALTER TABLE "BlroAuthorityCutover" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BlroAuthorityCutover" FORCE ROW LEVEL SECURITY;
CREATE POLICY "BlroAuthorityCutover_scope" ON "BlroAuthorityCutover"
  USING ("projectId" = current_setting('app.project_id', true))
  WITH CHECK ("projectId" = current_setting('app.project_id', true));
ALTER TABLE "BlroProjectAuthorityEpoch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BlroProjectAuthorityEpoch" FORCE ROW LEVEL SECURITY;
CREATE POLICY "BlroProjectAuthorityEpoch_scope" ON "BlroProjectAuthorityEpoch"
  USING ("projectId" = current_setting('app.project_id', true))
  WITH CHECK ("projectId" = current_setting('app.project_id', true));
ALTER TABLE "BlroLocalWriteIntent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BlroLocalWriteIntent" FORCE ROW LEVEL SECURITY;
CREATE POLICY "BlroLocalWriteIntent_scope" ON "BlroLocalWriteIntent"
  USING ("projectId" = current_setting('app.project_id', true))
  WITH CHECK ("projectId" = current_setting('app.project_id', true));
ALTER TABLE "BlroAuthorityCutoverStaging" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BlroAuthorityCutoverStaging" FORCE ROW LEVEL SECURITY;
CREATE POLICY "BlroAuthorityCutoverStaging_scope" ON "BlroAuthorityCutoverStaging"
  USING ("projectId" = current_setting('app.project_id', true))
  WITH CHECK ("projectId" = current_setting('app.project_id', true));

-- Outstanding execution and approval authority is epoch-bound. Promotion
-- increments the cutover epoch; old rows cannot be replayed and must be reissued.
ALTER TABLE "BlroRun" ADD COLUMN "authorityEpoch" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "BlroApproval" ADD COLUMN "authorityEpoch" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "BlroApprovalNonce" ADD COLUMN "authorityEpoch" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "BlroRemoteJob" ADD COLUMN "authorityEpoch" INTEGER NOT NULL DEFAULT 0;
-- The default exists only for PostgreSQL's RLS-independent existing-row materialization.
ALTER TABLE "BlroRun" ALTER COLUMN "authorityEpoch" DROP DEFAULT;
ALTER TABLE "BlroApproval" ALTER COLUMN "authorityEpoch" DROP DEFAULT;
ALTER TABLE "BlroApprovalNonce" ALTER COLUMN "authorityEpoch" DROP DEFAULT;
ALTER TABLE "BlroRemoteJob" ALTER COLUMN "authorityEpoch" DROP DEFAULT;
CREATE INDEX "BlroRun_projectId_authorityEpoch_idx" ON "BlroRun"("projectId", "authorityEpoch");
CREATE INDEX "BlroApproval_projectId_authorityEpoch_idx" ON "BlroApproval"("projectId", "authorityEpoch");
CREATE INDEX "BlroApprovalNonce_projectId_authorityEpoch_idx" ON "BlroApprovalNonce"("projectId", "authorityEpoch");
CREATE INDEX "BlroRemoteJob_projectId_authorityEpoch_idx" ON "BlroRemoteJob"("projectId", "authorityEpoch");

-- Cutover-owned legacy audit rows may be removed only while that aggregate is
-- still rollbackable. Ordinary audit rows and every row at/after FROZEN remain
-- physically append-only.
CREATE OR REPLACE FUNCTION "blro_refuse_audit_rewrite"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
    AND OLD."kind" LIKE 'legacy.%'
    AND EXISTS (
      SELECT 1 FROM "BlroAuthorityCutover" c
      WHERE c."projectId" = OLD."projectId" AND c."aggregate" = 'audit'
        AND c."state" IN ('LOCAL_PRIMARY','BACKFILLING','SHADOW_READING')
    )
  THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'BLRO_AUDIT_APPEND_ONLY';
END;
$$;
