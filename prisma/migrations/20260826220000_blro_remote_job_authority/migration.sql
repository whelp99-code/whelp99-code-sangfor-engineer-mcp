-- Todo 22: durable at-most-once remote-job dispatch authority.
UPDATE "BlroRuntimeSchema" SET "version"='20260826220000_blro_remote_job_authority'
WHERE "component"='control-tower-authority';

-- The old table was a derived completed-result cache. It had no dispatch
-- tombstone, request digest, installation scope, or safe migration semantics.
DROP TABLE "BlroBrowserJobResult";

ALTER TABLE "BlroEnrollmentIdentity"
  ADD CONSTRAINT "BlroEnrollmentIdentity_tenant_project_installation_key"
  UNIQUE ("tenantId","projectId","installationId");

CREATE TABLE "BlroRemoteJobCapabilityJti" (
  "jti" TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "installationId" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "requestDigest" TEXT NOT NULL,
  "capabilityExpiresAt" TIMESTAMPTZ(3) NOT NULL,
  "consumedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "BlroRemoteJobCapabilityJti_tenant_fkey" FOREIGN KEY ("tenantId")
    REFERENCES "BlroTenant"("id") ON DELETE RESTRICT,
  CONSTRAINT "BlroRemoteJobCapabilityJti_project_fkey" FOREIGN KEY ("projectId","tenantId")
    REFERENCES "BlroProject"("id","tenantId") ON DELETE RESTRICT,
  CONSTRAINT "BlroRemoteJobCapabilityJti_enrollment_fkey"
    FOREIGN KEY ("tenantId","projectId","installationId")
    REFERENCES "BlroEnrollmentIdentity"("tenantId","projectId","installationId") ON DELETE RESTRICT,
  CONSTRAINT "BlroRemoteJobCapabilityJti_binding_key"
    UNIQUE ("jti","tenantId","projectId","installationId","jobId","requestDigest"),
  CONSTRAINT "BlroRemoteJobCapabilityJti_digest_check" CHECK ("requestDigest" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "BlroRemoteJobCapabilityJti_time_check" CHECK ("capabilityExpiresAt">"consumedAt"),
  CONSTRAINT "BlroRemoteJobCapabilityJti_ids_check" CHECK (
    length("jti")>0 AND length("installationId")>0 AND length("jobId")>0)
);
CREATE INDEX "BlroRemoteJobCapabilityJti_project_installation_job_idx"
  ON "BlroRemoteJobCapabilityJti"("projectId","installationId","jobId");

CREATE TABLE "BlroRemoteJob" (
  "id" TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "installationId" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "stepId" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "requestDigest" TEXT NOT NULL,
  "capabilityJti" TEXT NOT NULL UNIQUE,
  "state" TEXT NOT NULL,
  "result" JSONB,
  "resultDigest" TEXT,
  "tombstoneCommittedAt" TIMESTAMPTZ(3) NOT NULL,
  "resultCommittedAt" TIMESTAMPTZ(3),
  "indeterminateAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "BlroRemoteJob_tenant_fkey" FOREIGN KEY ("tenantId")
    REFERENCES "BlroTenant"("id") ON DELETE RESTRICT,
  CONSTRAINT "BlroRemoteJob_project_fkey" FOREIGN KEY ("projectId","tenantId")
    REFERENCES "BlroProject"("id","tenantId") ON DELETE RESTRICT,
  CONSTRAINT "BlroRemoteJob_enrollment_fkey"
    FOREIGN KEY ("tenantId","projectId","installationId")
    REFERENCES "BlroEnrollmentIdentity"("tenantId","projectId","installationId") ON DELETE RESTRICT,
  CONSTRAINT "BlroRemoteJob_capability_fkey"
    FOREIGN KEY ("capabilityJti","tenantId","projectId","installationId","jobId","requestDigest")
    REFERENCES "BlroRemoteJobCapabilityJti"("jti","tenantId","projectId","installationId","jobId","requestDigest")
    ON DELETE RESTRICT,
  CONSTRAINT "BlroRemoteJob_scope_job_key"
    UNIQUE ("tenantId","projectId","installationId","jobId"),
  CONSTRAINT "BlroRemoteJob_scope_job_digest_key"
    UNIQUE ("tenantId","projectId","installationId","jobId","requestDigest"),
  CONSTRAINT "BlroRemoteJob_capability_binding_key"
    UNIQUE ("capabilityJti","tenantId","projectId","installationId","jobId","requestDigest"),
  CONSTRAINT "BlroRemoteJob_request_digest_check" CHECK ("requestDigest" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "BlroRemoteJob_result_digest_check" CHECK (
    "resultDigest" IS NULL OR "resultDigest" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "BlroRemoteJob_state_check" CHECK ("state" IN (
    'dispatch_committed','result_retained','indeterminate')),
  CONSTRAINT "BlroRemoteJob_state_payload_check" CHECK (
    ("state"='dispatch_committed' AND "resultCommittedAt" IS NULL AND "indeterminateAt" IS NULL)
    OR ("state"='result_retained' AND "resultCommittedAt" IS NOT NULL AND "indeterminateAt" IS NULL)
    OR ("state"='indeterminate' AND "result" IS NULL AND "resultDigest" IS NULL
      AND "resultCommittedAt" IS NULL AND "indeterminateAt" IS NOT NULL)
  ),
  CONSTRAINT "BlroRemoteJob_time_check" CHECK (
    "updatedAt">="createdAt" AND
    ("resultCommittedAt" IS NULL OR "resultCommittedAt">="tombstoneCommittedAt") AND
    ("indeterminateAt" IS NULL OR "indeterminateAt">="tombstoneCommittedAt")),
  CONSTRAINT "BlroRemoteJob_ids_check" CHECK (
    length("installationId")>0 AND length("jobId")>0 AND length("runId")>0
    AND length("stepId")>0 AND length("requestId")>0)
);
CREATE INDEX "BlroRemoteJob_project_installation_state_idx"
  ON "BlroRemoteJob"("projectId","installationId","state");

DO $scope$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['BlroRemoteJobCapabilityJti','BlroRemoteJob'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING ("projectId" = current_setting(''app.project_id'', true)) WITH CHECK ("projectId" = current_setting(''app.project_id'', true))',
      table_name || '_scope', table_name
    );
  END LOOP;
END $scope$;
