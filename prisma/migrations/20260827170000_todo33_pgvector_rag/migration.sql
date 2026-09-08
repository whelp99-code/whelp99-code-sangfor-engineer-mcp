-- Todo 33: owner-installed pgvector and PostgreSQL-native project RAG authority.
-- Runtime roles receive table DML through owner default privileges; they do not
-- own the extension, database, schema, tables, or HNSW index.
CREATE EXTENSION IF NOT EXISTS vector;

DO $extension$
DECLARE installed_version TEXT;
BEGIN
  SELECT extversion INTO installed_version FROM pg_extension WHERE extname='vector';
  IF installed_version IS DISTINCT FROM '0.8.1' THEN
    RAISE EXCEPTION 'RAG_PGVECTOR_VERSION_UNSUPPORTED: expected 0.8.1, received %', coalesce(installed_version,'missing');
  END IF;
END $extension$;

CREATE TABLE "BlroRagEmbeddingCohort" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "indexEpoch" INTEGER NOT NULL CHECK ("indexEpoch">=0),
  "backend" TEXT NOT NULL CHECK (length("backend")>0),
  "model" TEXT NOT NULL CHECK (length("model")>0),
  "dimensions" INTEGER NOT NULL CHECK ("dimensions"=384),
  "active" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BlroRagEmbeddingCohort_pkey" PRIMARY KEY ("tenantId","projectId","id"),
  CONSTRAINT "t24_tp_d42daa648bc18b2d" FOREIGN KEY ("tenantId","projectId")
    REFERENCES "BlroProject"("tenantId","id") ON DELETE RESTRICT,
  CONSTRAINT "BlroRagEmbeddingCohort_identity_key"
    UNIQUE ("tenantId","projectId","indexEpoch","backend","model","dimensions")
);
CREATE INDEX "BlroRagEmbeddingCohort_scope_epoch_idx"
  ON "BlroRagEmbeddingCohort" ("tenantId","projectId","indexEpoch");
CREATE UNIQUE INDEX "BlroRagEmbeddingCohort_one_active_epoch_key"
  ON "BlroRagEmbeddingCohort" ("tenantId","projectId","indexEpoch") WHERE "active";

CREATE TABLE "BlroRagAuthoritativeChunk" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "product" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "sourceType" TEXT NOT NULL,
  "trustLevel" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "sourceRef" TEXT NOT NULL,
  "contentHash" TEXT NOT NULL,
  "aclActorIds" TEXT[] NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BlroRagAuthoritativeChunk_pkey" PRIMARY KEY ("tenantId","projectId","id"),
  CONSTRAINT "t24_tp_b1f906738ece36f8" FOREIGN KEY ("tenantId","projectId")
    REFERENCES "BlroProject"("tenantId","id") ON DELETE RESTRICT,
  CONSTRAINT "BlroRagAuthoritativeChunk_membership_fkey" FOREIGN KEY ("tenantId","projectId","actorId")
    REFERENCES "BlroMembership"("tenantId","projectId","actorId") ON DELETE RESTRICT,
  CONSTRAINT "BlroRagAuthoritativeChunk_content_key" UNIQUE ("tenantId","projectId","contentHash")
);
CREATE INDEX "BlroRagAuthoritativeChunk_scope_filters_idx"
  ON "BlroRagAuthoritativeChunk" ("tenantId","projectId","product","version","sourceType","trustLevel");
CREATE INDEX "BlroRagAuthoritativeChunk_acl_idx"
  ON "BlroRagAuthoritativeChunk" USING gin ("aclActorIds");

CREATE TABLE "BlroRagEmbedding" (
  "tenantId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "chunkId" TEXT NOT NULL,
  "cohortId" TEXT NOT NULL,
  "product" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "sourceType" TEXT NOT NULL,
  "trustLevel" TEXT NOT NULL,
  "aclActorIds" TEXT[] NOT NULL DEFAULT '{}',
  "embedding" vector(384) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BlroRagEmbedding_pkey" PRIMARY KEY ("tenantId","projectId","chunkId","cohortId"),
  CONSTRAINT "t24_tp_03d09a81b2d16768" FOREIGN KEY ("tenantId","projectId")
    REFERENCES "BlroProject"("tenantId","id") ON DELETE RESTRICT,
  CONSTRAINT "BlroRagEmbedding_chunk_fkey" FOREIGN KEY ("tenantId","projectId","chunkId")
    REFERENCES "BlroRagAuthoritativeChunk"("tenantId","projectId","id") ON DELETE CASCADE,
  CONSTRAINT "BlroRagEmbedding_cohort_fkey" FOREIGN KEY ("tenantId","projectId","cohortId")
    REFERENCES "BlroRagEmbeddingCohort"("tenantId","projectId","id") ON DELETE RESTRICT
);
CREATE INDEX "BlroRagEmbedding_scope_cohort_idx"
  ON "BlroRagEmbedding" ("tenantId","projectId","cohortId");
CREATE INDEX "BlroRagEmbedding_scope_filters_idx"
  ON "BlroRagEmbedding" ("tenantId","projectId","cohortId","product","version","sourceType","trustLevel");
CREATE INDEX "BlroRagEmbedding_acl_idx"
  ON "BlroRagEmbedding" USING gin ("aclActorIds");
CREATE INDEX "BlroRagEmbedding_embedding_hnsw_idx"
  ON "BlroRagEmbedding" USING hnsw ("embedding" vector_cosine_ops)
  WITH (m=16, ef_construction=64);

DO $rls$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'BlroRagEmbeddingCohort','BlroRagAuthoritativeChunk','BlroRagEmbedding'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING ("projectId"=current_setting(''app.project_id'',true)) WITH CHECK ("projectId"=current_setting(''app.project_id'',true))',
      table_name || '_scope',table_name
    );
  END LOOP;
END $rls$;
