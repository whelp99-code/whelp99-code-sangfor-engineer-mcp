-- E09 persist tables were created with a Prisma-named composite FK
-- (projectId, tenantId) → (id, tenantId). The Todo 24 replay contract
-- requires the canonical t24_tp_<md5(table)> name and column order
-- (tenantId, projectId) → (tenantId, id). Without that name, replaying
-- 20260827010500_todo24_composite_ownership adds a second FK and the
-- catalog drifts. This migration is data-validating and replay-safe.

DO $migration$
DECLARE
  table_name TEXT;
  constraint_name TEXT;
  mismatch_exists BOOLEAN;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['BlroEngineerCase', 'BlroEngineerCaseArtifact'] LOOP
    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM %I child LEFT JOIN "BlroProject" p ON p."tenantId"=child."tenantId" AND p."id"=child."projectId" WHERE p."id" IS NULL)',
      table_name
    ) INTO mismatch_exists;
    IF mismatch_exists THEN
      RAISE EXCEPTION 'TODO24_COMPOSITE_OWNERSHIP_INVALID: %', table_name;
    END IF;

    constraint_name := 't24_tp_' || substr(md5(table_name), 1, 16);
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname=constraint_name AND conrelid=to_regclass(format('%I', table_name))
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY ("tenantId","projectId") REFERENCES "BlroProject"("tenantId","id") ON DELETE RESTRICT NOT VALID',
        table_name, constraint_name
      );
      EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', table_name, constraint_name);
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c
      WHERE c.conname=constraint_name
        AND c.conrelid=to_regclass(format('%I', table_name))
        AND c.confrelid='"BlroProject"'::regclass
        AND c.contype='f' AND c.convalidated
        AND c.confdeltype='r'::"char"
        AND ARRAY(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY k(attnum,n) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum ORDER BY k.n)=ARRAY['tenantId','projectId']::name[]
        AND ARRAY(SELECT a.attname FROM unnest(c.confkey) WITH ORDINALITY k(attnum,n) JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.attnum ORDER BY k.n)=ARRAY['tenantId','id']::name[]
    ) THEN
      RAISE EXCEPTION 'TODO24_COMPOSITE_FK_DEFINITION_INVALID: %', table_name;
    END IF;
  END LOOP;
END $migration$;
