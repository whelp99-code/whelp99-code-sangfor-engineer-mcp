-- Preserve the direct project ownership edge while making replay safe.
DO $migration$
DECLARE constraint_oid OID;
BEGIN
  IF EXISTS (
    SELECT 1 FROM "BlroLocalWriteIntent" i
    LEFT JOIN "BlroProject" p ON p."id"=i."projectId"
    WHERE p."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'TODO24_LOCAL_INTENT_PROJECT_OWNERSHIP_INVALID';
  END IF;

  SELECT oid INTO constraint_oid
  FROM pg_constraint
  WHERE conname='BlroLocalWriteIntent_projectId_fkey'
    AND conrelid='"BlroLocalWriteIntent"'::regclass;

  IF constraint_oid IS NULL THEN
    ALTER TABLE "BlroLocalWriteIntent"
      ADD CONSTRAINT "BlroLocalWriteIntent_projectId_fkey"
      FOREIGN KEY ("projectId") REFERENCES "BlroProject"("id")
      ON DELETE RESTRICT NOT VALID;
    ALTER TABLE "BlroLocalWriteIntent"
      VALIDATE CONSTRAINT "BlroLocalWriteIntent_projectId_fkey";
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conname='BlroLocalWriteIntent_projectId_fkey'
      AND c.conrelid='"BlroLocalWriteIntent"'::regclass
      AND c.confrelid='"BlroProject"'::regclass
      AND c.contype='f' AND c.confdeltype='r' AND c.convalidated
      AND ARRAY(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY k(attnum,n) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum ORDER BY k.n)=ARRAY['projectId']::name[]
      AND ARRAY(SELECT a.attname FROM unnest(c.confkey) WITH ORDINALITY k(attnum,n) JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.attnum ORDER BY k.n)=ARRAY['id']::name[]
  ) THEN
    RAISE EXCEPTION 'TODO24_LOCAL_INTENT_PROJECT_FK_DEFINITION_INVALID';
  END IF;
END $migration$;
