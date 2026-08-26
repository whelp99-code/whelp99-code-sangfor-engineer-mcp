-- BLRO process-runtime durability and an exact schema marker.
CREATE TABLE "BlroRuntimeSchema" (
  "component" TEXT PRIMARY KEY,
  "version" TEXT NOT NULL,
  "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "BlroRuntimeSchema" ("component","version")
VALUES ('control-tower-authority', '20260826170000_blro_runtime_stores');

CREATE TABLE "BlroClientEnrollment" (
  "id" TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL REFERENCES "BlroTenant"("id") ON DELETE RESTRICT,
  "projectId" TEXT NOT NULL,
  "installationId" TEXT NOT NULL,
  "certificateSerial" TEXT NOT NULL,
  "record" JSONB NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BlroClientEnrollment_projectId_tenantId_fkey"
    FOREIGN KEY ("projectId","tenantId") REFERENCES "BlroProject"("id","tenantId") ON DELETE RESTRICT,
  CONSTRAINT "BlroClientEnrollment_projectId_certificateSerial_key" UNIQUE ("projectId","certificateSerial")
);
CREATE INDEX "BlroClientEnrollment_projectId_installationId_idx"
  ON "BlroClientEnrollment"("projectId","installationId");

CREATE TABLE "BlroBrowserJobResult" (
  "id" TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL REFERENCES "BlroTenant"("id") ON DELETE RESTRICT,
  "projectId" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "result" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BlroBrowserJobResult_projectId_tenantId_fkey"
    FOREIGN KEY ("projectId","tenantId") REFERENCES "BlroProject"("id","tenantId") ON DELETE RESTRICT,
  CONSTRAINT "BlroBrowserJobResult_jobId_key" UNIQUE ("jobId")
);

DO $scope$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['BlroClientEnrollment','BlroBrowserJobResult'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING ("projectId" = current_setting(''app.project_id'', true)) WITH CHECK ("projectId" = current_setting(''app.project_id'', true))',
      table_name || '_scope', table_name
    );
  END LOOP;
END $scope$;
