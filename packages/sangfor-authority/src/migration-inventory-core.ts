export const IDENTITY_REFS = [
  "persist:packages/sangfor-authority/src/authority-store.ts#BlroAuthorityStore",
  "prisma:model:BlroActor",
  "prisma:model:BlroRole",
  "prisma:model:BlroRuntimeSchema",
  "prisma:model:BlroTenant",
] as const;

export const PROJECT_REFS = [
  "persist:packages/sangfor-authority/src/cutover/postgres-repository.ts#PostgresCutoverRepository",
  "persist:packages/sangfor-authority/src/cutover/postgres-target-base.ts#AggregatePostgresTarget",
  "persist:packages/sangfor-authority/src/cutover/write-intents.ts#PostgresLocalWriteIntentRepository",
  "persist:packages/sangfor-authority/src/authority-epoch.ts#read",
  "persist:packages/sangfor-authority/src/cutover/safety-marker.ts#writeLocalSafetyMarker",
  "persist:packages/sangfor-authority/src/cutover/target-common.ts#checkpointRecords",
  "persist:packages/sangfor-authority/src/enrollment-bootstrap.ts#claimScopedBootstrapToken",
  "persist:packages/sangfor-authority/src/enrollment-bootstrap.ts#issueScopedBootstrapToken",
  "persist:packages/sangfor-authority/src/enrollment-lifecycle.ts#acknowledgeScopedRotation",
  "persist:packages/sangfor-authority/src/enrollment-lifecycle.ts#rotateScopedEnrollment",
  "persist:packages/sangfor-authority/src/enrollment-revocation.ts#revokeScopedEnrollment",
  "prisma:model:BlroClientEnrollment",
  "prisma:model:BlroEnrollmentBootstrapToken",
  "prisma:model:BlroEnrollmentCertificate",
  "prisma:model:BlroEnrollmentGrant",
  "prisma:model:BlroEnrollmentIdentity",
  "prisma:model:BlroEnrollmentRotation",
  "prisma:model:BlroAuthorityCutover",
  "prisma:model:BlroAuthorityCutoverStaging",
  "prisma:model:BlroProjectAuthorityEpoch",
  "prisma:model:BlroLocalWriteIntent",
  "prisma:model:BlroSourceRootOwner",
  "prisma:model:BlroMembership",
  "prisma:model:BlroProject",
] as const;

export const REGISTRY_REFS = [
  "persist:apps/control-tower/src/playbook-store.ts#PlaybookStore",
  "persist:apps/control-tower/src/registry.ts#Registry",
  "persist:packages/sangfor-authority/src/cutover/core-aggregate-targets.ts#RegistryCutoverTarget",
  "prisma:model:BlroDevice",
  "prisma:model:BlroServiceRegistry",
  "prisma:model:SangforProduct",
] as const;

export const RUNS_REFS = [
  "persist:apps/control-tower/src/playbook-store.ts#AnalysisStore",
  "persist:packages/sangfor-runs/src/run-store.ts#RunStore",
  "persist:packages/sangfor-authority/src/cutover/core-aggregate-targets.ts#RunsCutoverTarget",
  "prisma:model:BlroRun",
  "prisma:model:BlroRunStep",
] as const;

export const APPROVAL_REFS = [
  "persist:packages/sangfor-approval/src/index.ts#FileSingleUseNonceStore",
  "persist:packages/sangfor-approval/src/index.ts#writeFileDescriptor",
  "persist:packages/sangfor-approval/src/postgres-nonce-store.ts#PostgresSingleUseNonceStore",
  // Backup captures outstanding approval/nonce authority; the scratch-only restore drill spends it.
  "persist:scripts/blro-backup.mjs#runBackup",
  "persist:scripts/blro-restore-drill.mjs#runDrill",
  "persist:scripts/lib/blro-drill-fixture.mjs#dropDrillFixture",
  "persist:scripts/lib/blro-drill-fixture.mjs#seedDrillFixture",
  "prisma:model:BlroApproval",
  "prisma:model:BlroApprovalNonce",
] as const;

export const AUDIT_REFS = [
  "persist:packages/sangfor-hci-client/src/audit-ledger.ts#AuditLedger",
  "persist:packages/sangfor-authority/src/cutover/core-aggregate-targets.ts#AuditCutoverTarget",
  // Recovery policy appends one keyed audit event per project, in scratch only.
  "persist:scripts/lib/blro-recovery-policy.mjs#applyRecoveryPolicy",
  "prisma:model:BlroAuditEvent",
] as const;

export const EVIDENCE_REFS = [
  "persist:packages/sangfor-engineer-report/src/ledger.ts#appendEngineerReport",
  "persist:packages/sangfor-authority/src/cutover/core-aggregate-targets.ts#EvidenceCutoverTarget",
  "prisma:model:BlroEvidenceManifest",
] as const;

export const RAG_SOURCE_REFS = [
  "prisma:model:BlroRagDocument",
  "prisma:model:BlroRagSourceChunk",
  "prisma:model:SangforRagChunk",
  "prisma:model:SangforRagDocument",
] as const;

export const RAG_EMBEDDING_REFS = [
  "persist:packages/sangfor-rag/src/index.ts#ingestDocument",
  "persist:packages/sangfor-rag/src/index.ts#ingestDocumentsBatch",
  "persist:packages/sangfor-rag/src/index.ts#saveRagIndex",
  "persist:packages/sangfor-rag/src/index.ts#saveRagIndexUnlocked",
  "persist:packages/sangfor-rag/src/storage.ts#saveShardedJsonlIndex",
  "prisma:model:BlroRagChunk",
] as const;

