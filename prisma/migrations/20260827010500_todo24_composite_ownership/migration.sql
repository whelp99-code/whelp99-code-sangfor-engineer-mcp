-- Every tenant-bearing project authority row is owned by one exact
-- (tenantId, projectId) pair. This migration is data-validating and replay-safe.
DO $migration$
DECLARE
  table_name TEXT;
  constraint_name TEXT;
  mismatch_exists BOOLEAN;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='BlroProject_tenantId_id_key'
      AND conrelid='"BlroProject"'::regclass
  ) THEN
    ALTER TABLE "BlroProject"
      ADD CONSTRAINT "BlroProject_tenantId_id_key" UNIQUE ("tenantId","id");
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='BlroMembership_tenantId_projectId_actorId_key'
      AND conrelid='"BlroMembership"'::regclass
  ) THEN
    ALTER TABLE "BlroMembership"
      ADD CONSTRAINT "BlroMembership_tenantId_projectId_actorId_key"
      UNIQUE ("tenantId","projectId","actorId");
  END IF;

  FOR table_name IN
    SELECT cols.table_name
    FROM information_schema.columns cols
    WHERE cols.table_schema=current_schema() AND cols.column_name IN ('tenantId','projectId')
      AND cols.table_name LIKE 'Blro%'
    GROUP BY cols.table_name
    HAVING count(DISTINCT cols.column_name)=2
    ORDER BY cols.table_name
  LOOP
    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM %I child LEFT JOIN "BlroProject" p ON p."tenantId"=child."tenantId" AND p."id"=child."projectId" WHERE p."id" IS NULL)',
      table_name
    ) INTO mismatch_exists;
    IF mismatch_exists THEN
      RAISE EXCEPTION 'TODO24_COMPOSITE_OWNERSHIP_INVALID: %', table_name;
    END IF;

    constraint_name := 't24_tp_' || substr(md5(table_name),1,16);
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname=constraint_name AND conrelid=to_regclass(format('%I',table_name))
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY ("tenantId","projectId") REFERENCES "BlroProject"("tenantId","id") ON DELETE %s NOT VALID',
        table_name, constraint_name,
        CASE WHEN table_name='BlroSourceRootOwner' THEN 'CASCADE' ELSE 'RESTRICT' END
      );
      EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I',table_name,constraint_name);
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c
      WHERE c.conname=constraint_name
        AND c.conrelid=to_regclass(format('%I',table_name))
        AND c.confrelid='"BlroProject"'::regclass
        AND c.contype='f' AND c.convalidated
        AND c.confdeltype=CASE WHEN table_name='BlroSourceRootOwner' THEN 'c'::"char" ELSE 'r'::"char" END
        AND ARRAY(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY k(attnum,n) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum ORDER BY k.n)=ARRAY['tenantId','projectId']::name[]
        AND ARRAY(SELECT a.attname FROM unnest(c.confkey) WITH ORDINALITY k(attnum,n) JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.attnum ORDER BY k.n)=ARRAY['tenantId','id']::name[]
    ) THEN
      RAISE EXCEPTION 'TODO24_COMPOSITE_FK_DEFINITION_INVALID: %', table_name;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM "BlroLocalWriteIntent" i
    LEFT JOIN "BlroMembership" m
      ON m."tenantId"=i."tenantId" AND m."projectId"=i."projectId" AND m."actorId"=i."actorId"
    WHERE m."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'TODO24_LOCAL_INTENT_MEMBERSHIP_INVALID';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='t24_local_intent_membership'
      AND conrelid='"BlroLocalWriteIntent"'::regclass
  ) THEN
    ALTER TABLE "BlroLocalWriteIntent"
      ADD CONSTRAINT "t24_local_intent_membership"
      FOREIGN KEY ("tenantId","projectId","actorId")
      REFERENCES "BlroMembership"("tenantId","projectId","actorId")
      ON DELETE RESTRICT NOT VALID;
    ALTER TABLE "BlroLocalWriteIntent"
      VALIDATE CONSTRAINT "t24_local_intent_membership";
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conname='t24_local_intent_membership'
      AND c.conrelid='"BlroLocalWriteIntent"'::regclass
      AND c.confrelid='"BlroMembership"'::regclass
      AND c.contype='f' AND c.confdeltype='r' AND c.convalidated
      AND ARRAY(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY k(attnum,n) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum ORDER BY k.n)=ARRAY['tenantId','projectId','actorId']::name[]
      AND ARRAY(SELECT a.attname FROM unnest(c.confkey) WITH ORDINALITY k(attnum,n) JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.attnum ORDER BY k.n)=ARRAY['tenantId','projectId','actorId']::name[]
  ) THEN
    RAISE EXCEPTION 'TODO24_LOCAL_INTENT_MEMBERSHIP_FK_DEFINITION_INVALID';
  END IF;
END $migration$;
