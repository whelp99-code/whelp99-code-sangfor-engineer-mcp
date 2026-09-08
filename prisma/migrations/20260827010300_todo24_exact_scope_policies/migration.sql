-- Early scope policies relied on PostgreSQL's implicit WITH CHECK. Todo 24
-- requires the write boundary to be explicit and catalog-verifiable.
DROP POLICY "BlroProject_scope" ON "BlroProject";
CREATE POLICY "BlroProject_scope" ON "BlroProject"
  USING ("id" = current_setting('app.project_id', true))
  WITH CHECK ("id" = current_setting('app.project_id', true));

DROP POLICY "BlroApprovalNonce_scope" ON "BlroApprovalNonce";
CREATE POLICY "BlroApprovalNonce_scope" ON "BlroApprovalNonce"
  USING ("projectId" = current_setting('app.project_id', true))
  WITH CHECK ("projectId" = current_setting('app.project_id', true));

DROP POLICY "BlroAuditEvent_scope" ON "BlroAuditEvent";
CREATE POLICY "BlroAuditEvent_scope" ON "BlroAuditEvent"
  USING ("projectId" = current_setting('app.project_id', true))
  WITH CHECK ("projectId" = current_setting('app.project_id', true));
