-- E09A engineer-case aggregate. Run/evidence/RAG tables are a different
-- boundary; confidential originals stay out of the public search index.

CREATE TABLE "BlroEngineerCase" (
  "id" TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL REFERENCES "BlroTenant"("id") ON DELETE RESTRICT,
  "projectId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "revision" TEXT NOT NULL,
  "guideRevision" TEXT NOT NULL,
  "guideDigest" TEXT NOT NULL,
  "observationDigest" TEXT NOT NULL,
  "requirementDigest" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "requestDigest" TEXT NOT NULL,
  "environmentKind" TEXT NOT NULL,
  "originalPresent" BOOLEAN,
  "document" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BlroEngineerCase_projectId_tenantId_fkey"
    FOREIGN KEY ("projectId", "tenantId")
    REFERENCES "BlroProject"("id", "tenantId") ON DELETE RESTRICT,
  CONSTRAINT "BlroEngineerCase_id_projectId_key" UNIQUE ("id", "projectId"),
  CONSTRAINT "BlroEngineerCase_projectId_requestId_key" UNIQUE ("projectId", "requestId")
);
CREATE INDEX "BlroEngineerCase_projectId_revision_idx" ON "BlroEngineerCase"("projectId", "revision");
CREATE INDEX "BlroEngineerCase_projectId_idx" ON "BlroEngineerCase"("projectId");

CREATE TABLE "BlroEngineerCaseArtifact" (
  "id" TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL REFERENCES "BlroTenant"("id") ON DELETE RESTRICT,
  "projectId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "digest" TEXT NOT NULL,
  "mediaType" TEXT NOT NULL,
  "payload" TEXT NOT NULL,
  "sanitized" BOOLEAN NOT NULL,
  "retention" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BlroEngineerCaseArtifact_projectId_tenantId_fkey"
    FOREIGN KEY ("projectId", "tenantId")
    REFERENCES "BlroProject"("id", "tenantId") ON DELETE RESTRICT,
  CONSTRAINT "BlroEngineerCaseArtifact_caseId_projectId_fkey"
    FOREIGN KEY ("caseId", "projectId")
    REFERENCES "BlroEngineerCase"("id", "projectId") ON DELETE RESTRICT,
  CONSTRAINT "BlroEngineerCaseArtifact_id_projectId_key" UNIQUE ("id", "projectId"),
  CONSTRAINT "BlroEngineerCaseArtifact_projectId_caseId_digest_key" UNIQUE ("projectId", "caseId", "digest")
);
CREATE INDEX "BlroEngineerCaseArtifact_projectId_caseId_idx" ON "BlroEngineerCaseArtifact"("projectId", "caseId");
CREATE INDEX "BlroEngineerCaseArtifact_projectId_idx" ON "BlroEngineerCaseArtifact"("projectId");

DO $scope$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['BlroEngineerCase', 'BlroEngineerCaseArtifact'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING ("projectId" = current_setting(''app.project_id'', true)) WITH CHECK ("projectId" = current_setting(''app.project_id'', true))',
      table_name || '_scope', table_name
    );
  END LOOP;
END $scope$;
