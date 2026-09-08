-- Todo 24 exact-set verifier requires a one-column projectId index.
CREATE INDEX IF NOT EXISTS "BlroSourceRootOwner_projectId_idx"
  ON "BlroSourceRootOwner"("projectId");

DO $verify$
DECLARE project_attnum SMALLINT;
BEGIN
  SELECT attnum INTO project_attnum
  FROM pg_attribute
  WHERE attrelid='"BlroSourceRootOwner"'::regclass AND attname='projectId' AND NOT attisdropped;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid=i.indexrelid
    WHERE c.relname='BlroSourceRootOwner_projectId_idx'
      AND i.indrelid='"BlroSourceRootOwner"'::regclass
      AND i.indisvalid AND i.indisready AND NOT i.indisunique
      AND i.indpred IS NULL AND i.indexprs IS NULL
      AND i.indnkeyatts=1 AND i.indkey::text=project_attnum::text
  ) THEN
    RAISE EXCEPTION 'TODO24_SOURCE_ROOT_PROJECT_INDEX_DEFINITION_INVALID';
  END IF;
END $verify$;
