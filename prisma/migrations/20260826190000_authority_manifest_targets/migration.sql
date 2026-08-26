-- Todo 20 schema artifacts only. This migration is intentionally not applied by the manifest checker.
CREATE TABLE "BlroServiceRegistry" (
  "id" TEXT PRIMARY KEY, "tenantId" TEXT NOT NULL, "projectId" TEXT NOT NULL,
  "kind" TEXT NOT NULL, "payload" JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "BlroPmRecord" (
  "id" TEXT PRIMARY KEY, "tenantId" TEXT NOT NULL, "projectId" TEXT NOT NULL,
  "kind" TEXT NOT NULL, "payload" JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "BlroFeedbackLesson" (
  "id" TEXT PRIMARY KEY, "tenantId" TEXT NOT NULL, "projectId" TEXT NOT NULL,
  "kind" TEXT NOT NULL, "payload" JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "BlroEvalRecord" (
  "id" TEXT PRIMARY KEY, "tenantId" TEXT NOT NULL, "projectId" TEXT NOT NULL,
  "kind" TEXT NOT NULL, "payload" JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "BlroWikiProposal" (
  "id" TEXT PRIMARY KEY, "tenantId" TEXT NOT NULL, "projectId" TEXT NOT NULL,
  "kind" TEXT NOT NULL, "payload" JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "BlroLearningRecord" (
  "id" TEXT PRIMARY KEY, "tenantId" TEXT NOT NULL, "projectId" TEXT NOT NULL,
  "kind" TEXT NOT NULL, "payload" JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "BlroFirmwareEvidence" (
  "id" TEXT PRIMARY KEY, "tenantId" TEXT NOT NULL, "projectId" TEXT NOT NULL,
  "kind" TEXT NOT NULL, "payload" JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "BlroConfigChronicle" (
  "id" TEXT PRIMARY KEY, "tenantId" TEXT NOT NULL, "projectId" TEXT NOT NULL,
  "kind" TEXT NOT NULL, "payload" JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "BlroCapabilityEvidence" (
  "id" TEXT PRIMARY KEY, "tenantId" TEXT NOT NULL, "projectId" TEXT NOT NULL,
  "kind" TEXT NOT NULL, "payload" JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "BlroRagSourceChunk" (
  "id" TEXT PRIMARY KEY, "tenantId" TEXT NOT NULL, "projectId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL, "text" TEXT NOT NULL, "contentHash" TEXT NOT NULL,
  "aclActorIds" TEXT[] NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BlroRagSourceChunk_projectId_contentHash_key" UNIQUE ("projectId", "contentHash")
);

DO $constraints$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'BlroServiceRegistry','BlroPmRecord','BlroFeedbackLesson','BlroEvalRecord',
    'BlroWikiProposal','BlroLearningRecord','BlroFirmwareEvidence',
    'BlroConfigChronicle','BlroCapabilityEvidence','BlroRagSourceChunk'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY ("tenantId") REFERENCES "BlroTenant"("id") ON DELETE RESTRICT', table_name, table_name || '_tenantId_fkey');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY ("projectId","tenantId") REFERENCES "BlroProject"("id","tenantId") ON DELETE RESTRICT', table_name, table_name || '_projectId_tenantId_fkey');
  END LOOP;
END $constraints$;

CREATE INDEX "BlroServiceRegistry_projectId_kind_idx" ON "BlroServiceRegistry"("projectId", "kind");
CREATE INDEX "BlroPmRecord_projectId_kind_idx" ON "BlroPmRecord"("projectId", "kind");
CREATE INDEX "BlroFeedbackLesson_projectId_kind_idx" ON "BlroFeedbackLesson"("projectId", "kind");
CREATE INDEX "BlroEvalRecord_projectId_kind_idx" ON "BlroEvalRecord"("projectId", "kind");
CREATE INDEX "BlroWikiProposal_projectId_kind_idx" ON "BlroWikiProposal"("projectId", "kind");
CREATE INDEX "BlroLearningRecord_projectId_kind_idx" ON "BlroLearningRecord"("projectId", "kind");
CREATE INDEX "BlroFirmwareEvidence_projectId_kind_idx" ON "BlroFirmwareEvidence"("projectId", "kind");
CREATE INDEX "BlroConfigChronicle_projectId_kind_idx" ON "BlroConfigChronicle"("projectId", "kind");
CREATE INDEX "BlroCapabilityEvidence_projectId_kind_idx" ON "BlroCapabilityEvidence"("projectId", "kind");
CREATE INDEX "BlroRagSourceChunk_projectId_documentId_idx" ON "BlroRagSourceChunk"("projectId", "documentId");

DO $scope$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'BlroServiceRegistry','BlroPmRecord','BlroFeedbackLesson','BlroEvalRecord',
    'BlroWikiProposal','BlroLearningRecord','BlroFirmwareEvidence',
    'BlroConfigChronicle','BlroCapabilityEvidence','BlroRagSourceChunk'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING ("projectId" = current_setting(''app.project_id'', true)) WITH CHECK ("projectId" = current_setting(''app.project_id'', true))',
      table_name || '_scope', table_name
    );
  END LOOP;
END $scope$;
