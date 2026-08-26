-- Audit hashes bind the exact ISO instant. A timestamp without time zone is
-- shifted when clients and PostgreSQL use different zones, breaking the chain.
ALTER TABLE "BlroAuditEvent"
  ALTER COLUMN "at" TYPE TIMESTAMPTZ(3)
  USING "at" AT TIME ZONE current_setting('TimeZone');
