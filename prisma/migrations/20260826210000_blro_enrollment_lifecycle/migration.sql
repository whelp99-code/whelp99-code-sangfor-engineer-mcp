-- Todo 21: normalized, project-scoped enrollment, certificate lifecycle, and grants.
UPDATE "BlroRuntimeSchema" SET "version"='20260826210000_blro_enrollment_lifecycle'
WHERE "component"='control-tower-authority';

CREATE TABLE "BlroEnrollmentIdentity" (
  "id" TEXT PRIMARY KEY, "tenantId" TEXT NOT NULL, "projectId" TEXT NOT NULL,
  "installationId" TEXT NOT NULL, "deviceBindingDigest" TEXT NOT NULL,
  "clientIdentityId" TEXT NOT NULL, "state" TEXT NOT NULL, "revision" INTEGER NOT NULL,
  "currentCertificateSerial" TEXT NOT NULL, "createdAt" TIMESTAMPTZ(3) NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL, "revokedAt" TIMESTAMPTZ(3),
  "revocationReason" TEXT, "revocationRevision" INTEGER,
  CONSTRAINT "BlroEnrollmentIdentity_project_fkey" FOREIGN KEY ("projectId","tenantId")
    REFERENCES "BlroProject"("id","tenantId") ON DELETE RESTRICT,
  CONSTRAINT "BlroEnrollmentIdentity_tenant_fkey" FOREIGN KEY ("tenantId")
    REFERENCES "BlroTenant"("id") ON DELETE RESTRICT,
  CONSTRAINT "BlroEnrollmentIdentity_project_installation_key" UNIQUE ("projectId","installationId"),
  CONSTRAINT "BlroEnrollmentIdentity_project_client_key" UNIQUE ("projectId","clientIdentityId"),
  CONSTRAINT "BlroEnrollmentIdentity_id_project_key" UNIQUE ("id","projectId"),
  CONSTRAINT "BlroEnrollmentIdentity_digest_check" CHECK ("deviceBindingDigest" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "BlroEnrollmentIdentity_state_check" CHECK ("state" IN ('active','revoked')),
  CONSTRAINT "BlroEnrollmentIdentity_revision_check" CHECK ("revision">0),
  CONSTRAINT "BlroEnrollmentIdentity_revocation_check" CHECK (
    ("state"='active' AND "revokedAt" IS NULL AND "revocationReason" IS NULL AND "revocationRevision" IS NULL)
    OR ("state"='revoked' AND "revokedAt" IS NOT NULL AND "revocationReason" IS NOT NULL
      AND "revocationRevision"="revision")
  )
);
CREATE INDEX "BlroEnrollmentIdentity_project_device_idx"
  ON "BlroEnrollmentIdentity"("projectId","deviceBindingDigest");

CREATE TABLE "BlroEnrollmentCertificate" (
  "id" TEXT PRIMARY KEY, "tenantId" TEXT NOT NULL, "projectId" TEXT NOT NULL,
  "enrollmentId" TEXT NOT NULL, "issuerChainRef" TEXT NOT NULL, "issuer" TEXT NOT NULL,
  "subjectAltNames" TEXT[] NOT NULL, "extendedKeyUsages" TEXT[] NOT NULL,
  "serial" TEXT NOT NULL, "fingerprintSha256" TEXT NOT NULL,
  "notBefore" TIMESTAMPTZ(3) NOT NULL, "notAfter" TIMESTAMPTZ(3) NOT NULL,
  "state" TEXT NOT NULL, "revision" INTEGER NOT NULL, "overlapExpiresAt" TIMESTAMPTZ(3),
  "acknowledgedAt" TIMESTAMPTZ(3), "revokedAt" TIMESTAMPTZ(3), "revocationReason" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "BlroEnrollmentCertificate_project_fkey" FOREIGN KEY ("projectId","tenantId")
    REFERENCES "BlroProject"("id","tenantId") ON DELETE RESTRICT,
  CONSTRAINT "BlroEnrollmentCertificate_tenant_fkey" FOREIGN KEY ("tenantId")
    REFERENCES "BlroTenant"("id") ON DELETE RESTRICT,
  CONSTRAINT "BlroEnrollmentCertificate_enrollment_fkey" FOREIGN KEY ("enrollmentId","projectId")
    REFERENCES "BlroEnrollmentIdentity"("id","projectId") ON DELETE RESTRICT,
  CONSTRAINT "BlroEnrollmentCertificate_project_serial_key" UNIQUE ("projectId","serial"),
  CONSTRAINT "BlroEnrollmentCertificate_project_fingerprint_key" UNIQUE ("projectId","fingerprintSha256"),
  CONSTRAINT "BlroEnrollmentCertificate_fingerprint_check" CHECK (
    "issuerChainRef" ~ '^[a-f0-9]{64}$' AND "fingerprintSha256" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "BlroEnrollmentCertificate_validity_check" CHECK (
    "notAfter">"notBefore" AND cardinality("subjectAltNames")=2),
  CONSTRAINT "BlroEnrollmentCertificate_state_check" CHECK ("state" IN ('active','overlap','revoked','superseded')),
  CONSTRAINT "BlroEnrollmentCertificate_revision_check" CHECK ("revision">0),
  CONSTRAINT "BlroEnrollmentCertificate_client_eku_check" CHECK ('1.3.6.1.5.5.7.3.2'=ANY("extendedKeyUsages")),
  CONSTRAINT "BlroEnrollmentCertificate_overlap_check" CHECK (
    ("state"='overlap' AND "overlapExpiresAt" IS NOT NULL)
    OR ("state"<>'overlap')
  ),
  CONSTRAINT "BlroEnrollmentCertificate_revocation_check" CHECK (
    ("state"='revoked' AND "revokedAt" IS NOT NULL AND "revocationReason" IS NOT NULL)
    OR ("state"<>'revoked')
  )
);
CREATE INDEX "BlroEnrollmentCertificate_enrollment_state_idx"
  ON "BlroEnrollmentCertificate"("projectId","enrollmentId","state");
CREATE UNIQUE INDEX "BlroEnrollmentCertificate_one_active_idx"
  ON "BlroEnrollmentCertificate"("projectId","enrollmentId") WHERE "state"='active';
CREATE UNIQUE INDEX "BlroEnrollmentCertificate_one_overlap_idx"
  ON "BlroEnrollmentCertificate"("projectId","enrollmentId") WHERE "state"='overlap';

CREATE TABLE "BlroEnrollmentGrant" (
  "id" TEXT PRIMARY KEY, "tenantId" TEXT NOT NULL, "projectId" TEXT NOT NULL,
  "enrollmentId" TEXT NOT NULL, "originDigest" TEXT NOT NULL, "scope" TEXT NOT NULL,
  "revision" INTEGER NOT NULL, "createdAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "BlroEnrollmentGrant_project_fkey" FOREIGN KEY ("projectId","tenantId")
    REFERENCES "BlroProject"("id","tenantId") ON DELETE RESTRICT,
  CONSTRAINT "BlroEnrollmentGrant_tenant_fkey" FOREIGN KEY ("tenantId")
    REFERENCES "BlroTenant"("id") ON DELETE RESTRICT,
  CONSTRAINT "BlroEnrollmentGrant_enrollment_fkey" FOREIGN KEY ("enrollmentId","projectId")
    REFERENCES "BlroEnrollmentIdentity"("id","projectId") ON DELETE RESTRICT,
  CONSTRAINT "BlroEnrollmentGrant_exact_key" UNIQUE ("projectId","enrollmentId","originDigest","scope"),
  CONSTRAINT "BlroEnrollmentGrant_digest_check" CHECK ("originDigest" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "BlroEnrollmentGrant_revision_check" CHECK ("revision">0)
);
CREATE INDEX "BlroEnrollmentGrant_origin_scope_idx"
  ON "BlroEnrollmentGrant"("projectId","originDigest","scope");

CREATE TABLE "BlroEnrollmentBootstrapToken" (
  "id" TEXT PRIMARY KEY, "tenantId" TEXT NOT NULL, "projectId" TEXT NOT NULL,
  "installationId" TEXT NOT NULL, "deviceBindingDigest" TEXT NOT NULL,
  "tokenDigest" TEXT NOT NULL, "grants" JSONB NOT NULL, "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "claimedAt" TIMESTAMPTZ(3), "revision" INTEGER NOT NULL, "createdAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "BlroEnrollmentBootstrapToken_project_fkey" FOREIGN KEY ("projectId","tenantId")
    REFERENCES "BlroProject"("id","tenantId") ON DELETE RESTRICT,
  CONSTRAINT "BlroEnrollmentBootstrapToken_tenant_fkey" FOREIGN KEY ("tenantId")
    REFERENCES "BlroTenant"("id") ON DELETE RESTRICT,
  CONSTRAINT "BlroEnrollmentBootstrapToken_project_digest_key" UNIQUE ("projectId","tokenDigest"),
  CONSTRAINT "BlroEnrollmentBootstrapToken_digests_check" CHECK (
    "deviceBindingDigest" ~ '^[a-f0-9]{64}$' AND "tokenDigest" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "BlroEnrollmentBootstrapToken_revision_check" CHECK (
    ("revision"=0 AND "claimedAt" IS NULL) OR ("revision"=1 AND "claimedAt" IS NOT NULL))
);
CREATE INDEX "BlroEnrollmentBootstrapToken_installation_idx"
  ON "BlroEnrollmentBootstrapToken"("projectId","installationId");
CREATE INDEX "BlroEnrollmentBootstrapToken_expiry_idx"
  ON "BlroEnrollmentBootstrapToken"("projectId","expiresAt");

CREATE TABLE "BlroEnrollmentRotation" (
  "id" TEXT PRIMARY KEY, "tenantId" TEXT NOT NULL, "projectId" TEXT NOT NULL,
  "enrollmentId" TEXT NOT NULL, "oldSerial" TEXT NOT NULL, "newSerial" TEXT NOT NULL,
  "overlapExpiresAt" TIMESTAMPTZ(3) NOT NULL, "acknowledgedAt" TIMESTAMPTZ(3),
  "requestDigest" TEXT NOT NULL, "acknowledgementDigest" TEXT,
  "revision" INTEGER NOT NULL, "createdAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "BlroEnrollmentRotation_project_fkey" FOREIGN KEY ("projectId","tenantId")
    REFERENCES "BlroProject"("id","tenantId") ON DELETE RESTRICT,
  CONSTRAINT "BlroEnrollmentRotation_tenant_fkey" FOREIGN KEY ("tenantId")
    REFERENCES "BlroTenant"("id") ON DELETE RESTRICT,
  CONSTRAINT "BlroEnrollmentRotation_enrollment_fkey" FOREIGN KEY ("enrollmentId","projectId")
    REFERENCES "BlroEnrollmentIdentity"("id","projectId") ON DELETE RESTRICT,
  CONSTRAINT "BlroEnrollmentRotation_exact_key" UNIQUE ("projectId","enrollmentId","oldSerial","newSerial"),
  CONSTRAINT "BlroEnrollmentRotation_request_key" UNIQUE ("projectId","requestDigest"),
  CONSTRAINT "BlroEnrollmentRotation_serial_check" CHECK ("oldSerial"<>"newSerial"),
  CONSTRAINT "BlroEnrollmentRotation_digest_check" CHECK (
    "requestDigest" ~ '^[a-f0-9]{64}$' AND
    ("acknowledgementDigest" IS NULL OR "acknowledgementDigest" ~ '^[a-f0-9]{64}$')),
  CONSTRAINT "BlroEnrollmentRotation_expiry_check" CHECK ("overlapExpiresAt">"createdAt"),
  CONSTRAINT "BlroEnrollmentRotation_revision_check" CHECK ("revision">1)
);
CREATE INDEX "BlroEnrollmentRotation_expiry_idx"
  ON "BlroEnrollmentRotation"("projectId","overlapExpiresAt");

DO $scope$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'BlroEnrollmentIdentity','BlroEnrollmentCertificate','BlroEnrollmentGrant',
    'BlroEnrollmentBootstrapToken','BlroEnrollmentRotation'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING ("projectId" = current_setting(''app.project_id'', true)) WITH CHECK ("projectId" = current_setting(''app.project_id'', true))',
      table_name || '_scope', table_name
    );
  END LOOP;
END $scope$;
