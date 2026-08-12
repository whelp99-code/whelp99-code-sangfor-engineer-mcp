-- Phase 3 authoritative stores. All mutations are owned by BlroAuthorityStore.
-- Superseded local stores are enumerated in
-- docs/design-docs/blro-authority-migration-manifest.json.

-- Composite candidate keys let every child prove its tenant/project lineage in
-- a foreign key, rather than trusting a caller to keep independently valid IDs
-- aligned.
ALTER TABLE "BlroProject"
  ADD CONSTRAINT "BlroProject_id_tenantId_key" UNIQUE ("id", "tenantId");
ALTER TABLE "BlroActor"
  ADD CONSTRAINT "BlroActor_id_tenantId_key" UNIQUE ("id", "tenantId");

ALTER TABLE "BlroApprovalNonce" ADD COLUMN "tenantId" TEXT;
UPDATE "BlroApprovalNonce" n
SET "tenantId" = p."tenantId"
FROM "BlroProject" p
WHERE p."id" = n."projectId";
ALTER TABLE "BlroApprovalNonce" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "BlroApprovalNonce"
  DROP CONSTRAINT "BlroApprovalNonce_projectId_fkey",
  ADD CONSTRAINT "BlroApprovalNonce_projectId_tenantId_fkey"
    FOREIGN KEY ("projectId", "tenantId")
    REFERENCES "BlroProject"("id", "tenantId") ON DELETE RESTRICT,
  ADD CONSTRAINT "BlroApprovalNonce_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "BlroTenant"("id") ON DELETE RESTRICT;

ALTER TABLE "BlroAuditEvent" ADD COLUMN "tenantId" TEXT;
UPDATE "BlroAuditEvent" e
SET "tenantId" = p."tenantId"
FROM "BlroProject" p
WHERE p."id" = e."projectId";
ALTER TABLE "BlroAuditEvent" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "BlroAuditEvent"
  DROP CONSTRAINT "BlroAuditEvent_projectId_fkey",
  ADD CONSTRAINT "BlroAuditEvent_projectId_tenantId_fkey"
    FOREIGN KEY ("projectId", "tenantId")
    REFERENCES "BlroProject"("id", "tenantId") ON DELETE RESTRICT,
  ADD CONSTRAINT "BlroAuditEvent_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "BlroTenant"("id") ON DELETE RESTRICT;

-- A signed approval nonce is single-use across the whole authority. Project
-- scope must not turn the same nonce into a second valid capability.
DROP INDEX "BlroApprovalNonce_projectId_nonce_key";
CREATE UNIQUE INDEX "BlroApprovalNonce_nonce_key" ON "BlroApprovalNonce"("nonce");

CREATE TABLE "BlroRole" (
  "id" TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "permissions" TEXT[] NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BlroRole_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "BlroTenant"("id") ON DELETE RESTRICT,
  CONSTRAINT "BlroRole_id_tenantId_key" UNIQUE ("id", "tenantId"),
  CONSTRAINT "BlroRole_tenantId_name_key" UNIQUE ("tenantId", "name")
);

CREATE TABLE "BlroMembership" (
  "id" TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "roleId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "BlroMembership_projectId_tenantId_fkey"
    FOREIGN KEY ("projectId", "tenantId") REFERENCES "BlroProject"("id", "tenantId") ON DELETE RESTRICT,
  CONSTRAINT "BlroMembership_actorId_tenantId_fkey"
    FOREIGN KEY ("actorId", "tenantId") REFERENCES "BlroActor"("id", "tenantId") ON DELETE RESTRICT,
  CONSTRAINT "BlroMembership_roleId_tenantId_fkey"
    FOREIGN KEY ("roleId", "tenantId") REFERENCES "BlroRole"("id", "tenantId") ON DELETE RESTRICT,
  CONSTRAINT "BlroMembership_projectId_actorId_key" UNIQUE ("projectId", "actorId")
);
CREATE INDEX "BlroMembership_actorId_idx" ON "BlroMembership"("actorId");

-- Optional audit/nonce actors must also belong to the row's project. A NULL
-- actor remains valid for unattributed system events/nonces.
ALTER TABLE "BlroApprovalNonce"
  DROP CONSTRAINT "BlroApprovalNonce_consumedByActorId_fkey",
  ADD CONSTRAINT "BlroApprovalNonce_projectId_consumedByActorId_fkey"
    FOREIGN KEY ("projectId", "consumedByActorId")
    REFERENCES "BlroMembership"("projectId", "actorId") ON DELETE RESTRICT;
ALTER TABLE "BlroAuditEvent"
  DROP CONSTRAINT "BlroAuditEvent_actorId_fkey",
  ADD CONSTRAINT "BlroAuditEvent_projectId_actorId_fkey"
    FOREIGN KEY ("projectId", "actorId")
    REFERENCES "BlroMembership"("projectId", "actorId") ON DELETE RESTRICT;

CREATE TABLE "BlroDevice" (
  "id" TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL REFERENCES "BlroTenant"("id") ON DELETE RESTRICT,
  "projectId" TEXT NOT NULL,
  "createdByActorId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "product" TEXT NOT NULL,
  "host" TEXT NOT NULL,
  "metadata" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BlroDevice_projectId_createdByActorId_fkey"
    FOREIGN KEY ("projectId", "createdByActorId")
    REFERENCES "BlroMembership"("projectId", "actorId") ON DELETE RESTRICT,
  CONSTRAINT "BlroDevice_projectId_tenantId_fkey"
    FOREIGN KEY ("projectId", "tenantId")
    REFERENCES "BlroProject"("id", "tenantId") ON DELETE RESTRICT,
  CONSTRAINT "BlroDevice_projectId_name_key" UNIQUE ("projectId", "name")
);

CREATE TABLE "BlroRun" (
  "id" TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL REFERENCES "BlroTenant"("id") ON DELETE RESTRICT,
  "projectId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "toolProfileVersion" TEXT NOT NULL,
  "sourceSystem" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BlroRun_projectId_actorId_fkey"
    FOREIGN KEY ("projectId", "actorId")
    REFERENCES "BlroMembership"("projectId", "actorId") ON DELETE RESTRICT,
  CONSTRAINT "BlroRun_projectId_tenantId_fkey"
    FOREIGN KEY ("projectId", "tenantId")
    REFERENCES "BlroProject"("id", "tenantId") ON DELETE RESTRICT,
  CONSTRAINT "BlroRun_id_projectId_key" UNIQUE ("id", "projectId")
);
CREATE INDEX "BlroRun_projectId_createdAt_idx" ON "BlroRun"("projectId", "createdAt");

CREATE TABLE "BlroRunStep" (
  "id" TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL REFERENCES "BlroTenant"("id") ON DELETE RESTRICT,
  "projectId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BlroRunStep_runId_projectId_fkey"
    FOREIGN KEY ("runId", "projectId") REFERENCES "BlroRun"("id", "projectId") ON DELETE RESTRICT,
  CONSTRAINT "BlroRunStep_projectId_actorId_fkey"
    FOREIGN KEY ("projectId", "actorId")
    REFERENCES "BlroMembership"("projectId", "actorId") ON DELETE RESTRICT,
  CONSTRAINT "BlroRunStep_projectId_tenantId_fkey"
    FOREIGN KEY ("projectId", "tenantId")
    REFERENCES "BlroProject"("id", "tenantId") ON DELETE RESTRICT,
  CONSTRAINT "BlroRunStep_runId_ordinal_key" UNIQUE ("runId", "ordinal")
);
CREATE INDEX "BlroRunStep_projectId_createdAt_idx" ON "BlroRunStep"("projectId", "createdAt");

CREATE TABLE "BlroApproval" (
  "id" TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL REFERENCES "BlroTenant"("id") ON DELETE RESTRICT,
  "projectId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "actionHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BlroApproval_projectId_actorId_fkey"
    FOREIGN KEY ("projectId", "actorId")
    REFERENCES "BlroMembership"("projectId", "actorId") ON DELETE RESTRICT,
  CONSTRAINT "BlroApproval_projectId_tenantId_fkey"
    FOREIGN KEY ("projectId", "tenantId")
    REFERENCES "BlroProject"("id", "tenantId") ON DELETE RESTRICT
);
CREATE INDEX "BlroApproval_projectId_actionHash_idx" ON "BlroApproval"("projectId", "actionHash");

CREATE TABLE "BlroEvidenceManifest" (
  "id" TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL REFERENCES "BlroTenant"("id") ON DELETE RESTRICT,
  "projectId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "contentHash" TEXT NOT NULL,
  "manifest" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BlroEvidenceManifest_projectId_actorId_fkey"
    FOREIGN KEY ("projectId", "actorId")
    REFERENCES "BlroMembership"("projectId", "actorId") ON DELETE RESTRICT,
  CONSTRAINT "BlroEvidenceManifest_runId_projectId_fkey"
    FOREIGN KEY ("runId", "projectId") REFERENCES "BlroRun"("id", "projectId") ON DELETE RESTRICT,
  CONSTRAINT "BlroEvidenceManifest_projectId_tenantId_fkey"
    FOREIGN KEY ("projectId", "tenantId")
    REFERENCES "BlroProject"("id", "tenantId") ON DELETE RESTRICT,
  CONSTRAINT "BlroEvidenceManifest_projectId_contentHash_key" UNIQUE ("projectId", "contentHash")
);

CREATE TABLE "BlroRagDocument" (
  "id" TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL REFERENCES "BlroTenant"("id") ON DELETE RESTRICT,
  "projectId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "sourceRef" TEXT NOT NULL,
  "contentHash" TEXT NOT NULL,
  "provenance" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BlroRagDocument_projectId_actorId_fkey"
    FOREIGN KEY ("projectId", "actorId")
    REFERENCES "BlroMembership"("projectId", "actorId") ON DELETE RESTRICT,
  CONSTRAINT "BlroRagDocument_projectId_tenantId_fkey"
    FOREIGN KEY ("projectId", "tenantId")
    REFERENCES "BlroProject"("id", "tenantId") ON DELETE RESTRICT,
  CONSTRAINT "BlroRagDocument_id_projectId_key" UNIQUE ("id", "projectId"),
  CONSTRAINT "BlroRagDocument_projectId_contentHash_key" UNIQUE ("projectId", "contentHash")
);

CREATE TABLE "BlroRagChunk" (
  "id" TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL REFERENCES "BlroTenant"("id") ON DELETE RESTRICT,
  "projectId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "contentHash" TEXT NOT NULL,
  "vector" JSONB,
  "aclActorIds" TEXT[] NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BlroRagChunk_documentId_projectId_fkey"
    FOREIGN KEY ("documentId", "projectId")
    REFERENCES "BlroRagDocument"("id", "projectId") ON DELETE RESTRICT,
  CONSTRAINT "BlroRagChunk_projectId_tenantId_fkey"
    FOREIGN KEY ("projectId", "tenantId")
    REFERENCES "BlroProject"("id", "tenantId") ON DELETE RESTRICT,
  CONSTRAINT "BlroRagChunk_projectId_contentHash_key" UNIQUE ("projectId", "contentHash")
);
CREATE INDEX "BlroRagChunk_projectId_documentId_idx" ON "BlroRagChunk"("projectId", "documentId");

-- Every project-bearing table refuses unscoped reads and writes at the database.
DO $scope$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'BlroMembership','BlroDevice','BlroRun','BlroRunStep','BlroApproval',
    'BlroEvidenceManifest','BlroRagDocument','BlroRagChunk'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING ("projectId" = current_setting(''app.project_id'', true)) WITH CHECK ("projectId" = current_setting(''app.project_id'', true))',
      table_name || '_scope', table_name
    );
  END LOOP;
END $scope$;

-- Audit is physically append-only. RLS does not apply to TRUNCATE, so both row
-- rewrite operations and table-wide truncation need explicit trigger guards.
CREATE FUNCTION "blro_refuse_audit_rewrite"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'BLRO_AUDIT_APPEND_ONLY';
END;
$$;
CREATE TRIGGER "BlroAuditEvent_append_only"
BEFORE UPDATE OR DELETE ON "BlroAuditEvent"
FOR EACH ROW EXECUTE FUNCTION "blro_refuse_audit_rewrite"();
CREATE TRIGGER "BlroAuditEvent_refuse_truncate"
BEFORE TRUNCATE ON "BlroAuditEvent"
FOR EACH STATEMENT EXECUTE FUNCTION "blro_refuse_audit_rewrite"();
