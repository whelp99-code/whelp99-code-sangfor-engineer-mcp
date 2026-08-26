export const IDENTITY_REFS = [
  "persist:packages/sangfor-authority/src/authority-store.ts#BlroAuthorityStore",
  "prisma:model:BlroActor",
  "prisma:model:BlroRole",
  "prisma:model:BlroRuntimeSchema",
  "prisma:model:BlroTenant",
] as const;

export const PROJECT_REFS = [
  "persist:packages/sangfor-browser-contracts/src/postgres-stores.ts#PostgresEnrollmentStore",
  "prisma:model:BlroClientEnrollment",
  "prisma:model:BlroMembership",
  "prisma:model:BlroProject",
] as const;

export const REGISTRY_REFS = [
  "persist:apps/control-tower/src/playbook-store.ts#PlaybookStore",
  "persist:apps/control-tower/src/registry.ts#Registry",
  "prisma:model:BlroDevice",
  "prisma:model:BlroServiceRegistry",
  "prisma:model:SangforProduct",
] as const;

export const RUNS_REFS = [
  "persist:apps/control-tower/src/playbook-store.ts#AnalysisStore",
  "persist:packages/sangfor-runs/src/run-store.ts#RunStore",
  "prisma:model:BlroRun",
  "prisma:model:BlroRunStep",
] as const;

export const APPROVAL_REFS = [
  "persist:packages/sangfor-approval/src/index.ts#FileSingleUseNonceStore",
  "persist:packages/sangfor-approval/src/postgres-nonce-store.ts#PostgresSingleUseNonceStore",
  "prisma:model:BlroApproval",
  "prisma:model:BlroApprovalNonce",
] as const;

export const AUDIT_REFS = [
  "persist:packages/sangfor-hci-client/src/audit-ledger.ts#AuditLedger",
  "prisma:model:BlroAuditEvent",
] as const;

export const EVIDENCE_REFS = [
  "persist:packages/sangfor-engineer-report/src/ledger.ts#appendEngineerReport",
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

