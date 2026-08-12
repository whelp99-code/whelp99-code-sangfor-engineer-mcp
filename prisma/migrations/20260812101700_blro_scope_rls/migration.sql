-- BLRO Phase 3 — tenant/project scope with row-level security (D1, D3, D4).
--
-- D4: ONE schema, shared tables, a mandatory project_id on every scoped row.
-- Not schema-per-project (migration drift across N schemas) and not
-- database-per-project (connection exhaustion, and it is the per-project silo
-- the platform goal forbids). Because every row carries project_id, promoting a
-- single project out later is a WHERE-clause export -- the exits stay open.
--
-- D3: the choke point is the DATABASE, not the application. An application-layer
-- wrapper is a convention that $queryRaw, a reporting script, or next quarter's
-- endpoint can skip silently. With RLS a forgotten predicate returns ZERO rows
-- (visible, fail-closed) instead of EVERY project's rows (silent leak).

-- ── Scope roots ─────────────────────────────────────────────────────────────

CREATE TABLE "BlroTenant" (
  "id"        TEXT PRIMARY KEY,
  "name"      TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "BlroProject" (
  "id"        TEXT PRIMARY KEY,
  "tenantId"  TEXT NOT NULL REFERENCES "BlroTenant"("id") ON DELETE RESTRICT,
  -- Set when this project was promoted from a legacy SANGFOR_ENGAGEMENT_ID (D1),
  -- so the provenance of the promotion stays auditable after cutover.
  "legacyEngagementId" TEXT,
  "name"      TEXT NOT NULL,
  "status"    TEXT NOT NULL DEFAULT 'active',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "BlroProject_tenantId_idx" ON "BlroProject"("tenantId");
CREATE UNIQUE INDEX "BlroProject_legacyEngagementId_key"
  ON "BlroProject"("legacyEngagementId") WHERE "legacyEngagementId" IS NOT NULL;

-- Actors exist to ATTRIBUTE work, including AI-engineer work a human PM
-- supervises. Deliberately not an IAM model: no roles table, no permission
-- matrix. Only the API key DIGEST is stored -- never a key value.
CREATE TABLE "BlroActor" (
  "id"            TEXT PRIMARY KEY,
  "tenantId"      TEXT NOT NULL REFERENCES "BlroTenant"("id") ON DELETE RESTRICT,
  "displayName"   TEXT NOT NULL,
  "actorType"     TEXT NOT NULL CHECK ("actorType" IN ('human_pm', 'ai_engineer', 'service')),
  "apiKeyDigest"  TEXT,
  "apiKeyIssuedAt" TIMESTAMP(3),
  "revokedAt"     TIMESTAMP(3),
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "BlroActor_tenantId_idx" ON "BlroActor"("tenantId");
CREATE UNIQUE INDEX "BlroActor_apiKeyDigest_key" ON "BlroActor"("apiKeyDigest")
  WHERE "apiKeyDigest" IS NOT NULL;

-- ── First scoped family: single-use approval nonces (D5 step 1) ─────────────
-- Migrated first because this is the one family where FILES ARE ACTIVELY WRONG:
-- data/runtime/approval-nonces.json is single-process safe only, so the moment
-- BLRO has two replicas "single use" becomes a race. The database gives what a
-- file cannot: a unique constraint plus a transactional consume.
CREATE TABLE "BlroApprovalNonce" (
  "id"         TEXT PRIMARY KEY,
  "projectId"  TEXT NOT NULL REFERENCES "BlroProject"("id") ON DELETE RESTRICT,
  "nonce"      TEXT NOT NULL,
  "expiresAt"  TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "consumedByActorId" TEXT REFERENCES "BlroActor"("id") ON DELETE SET NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Single-use is enforced by the DATABASE: one row per (project, nonce), and a
-- consume is UPDATE ... WHERE "consumedAt" IS NULL, so a second consumer
-- updates zero rows and is refused.
CREATE UNIQUE INDEX "BlroApprovalNonce_projectId_nonce_key"
  ON "BlroApprovalNonce"("projectId", "nonce");
CREATE INDEX "BlroApprovalNonce_expiresAt_idx" ON "BlroApprovalNonce"("expiresAt");

-- ── Second scoped family: append-only hash-chained audit (D5 step 2) ────────
-- Migrated early on purpose so the chain WITNESSES the remaining migrations.
CREATE TABLE "BlroAuditEvent" (
  "id"        TEXT PRIMARY KEY,
  "projectId" TEXT NOT NULL REFERENCES "BlroProject"("id") ON DELETE RESTRICT,
  "seq"       BIGINT NOT NULL,
  "at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "actorId"   TEXT REFERENCES "BlroActor"("id") ON DELETE SET NULL,
  "kind"      TEXT NOT NULL,
  "payload"   JSONB NOT NULL,
  "prevHash"  TEXT NOT NULL,
  "hash"      TEXT NOT NULL,
  -- false when no chain secret was configured; verify() must say so honestly
  -- rather than implying tamper-evidence it does not have.
  "keyed"     BOOLEAN NOT NULL DEFAULT false
);
-- A per-project monotonic sequence makes GAPS detectable, which append-only
-- JSONL cannot guarantee.
CREATE UNIQUE INDEX "BlroAuditEvent_projectId_seq_key" ON "BlroAuditEvent"("projectId", "seq");

-- ── D3: row-level security on every scoped table ───────────────────────────
-- FORCE also applies the policy to the table owner, so a migration or admin
-- path cannot quietly read across projects.

ALTER TABLE "BlroProject"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BlroProject"        FORCE  ROW LEVEL SECURITY;
ALTER TABLE "BlroApprovalNonce"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BlroApprovalNonce"  FORCE  ROW LEVEL SECURITY;
ALTER TABLE "BlroAuditEvent"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BlroAuditEvent"     FORCE  ROW LEVEL SECURITY;

-- current_setting(..., true) returns NULL when unset, so an unscoped connection
-- matches NOTHING. Fail-closed: forgetting to set the scope yields zero rows.
CREATE POLICY "BlroProject_scope" ON "BlroProject"
  USING ("id" = current_setting('app.project_id', true));
CREATE POLICY "BlroApprovalNonce_scope" ON "BlroApprovalNonce"
  USING ("projectId" = current_setting('app.project_id', true));
CREATE POLICY "BlroAuditEvent_scope" ON "BlroAuditEvent"
  USING ("projectId" = current_setting('app.project_id', true));
