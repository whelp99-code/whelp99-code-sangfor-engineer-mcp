export const FINETUNE_REFS = [
  "persist:packages/sangfor-finetune/src/index.ts#createFineTuneDataset",
  "prisma:model:SangforFineTuneDataset",
  "prisma:model:SangforFineTuneJob",
] as const;

export const CREDENTIAL_REFS = [
  "credential:scripts/run-mandatory-postgres-tests.ts#backupPassword",
  "credential:scripts/blro-migrate-authority.ts#runAuthorityCutoverCli",
  "credential:scripts/blro-restore-drill.mjs#requireAuditSecret",
  "credential:apps/control-tower/src/api.ts#createApi",
  "credential:apps/control-tower/src/bridge-client.ts#BridgeClient",
  "credential:apps/control-tower/src/server.ts#createTowerServer",
  "credential:apps/http-bridge/src/server.ts#<module>",
  "credential:apps/http-bridge/src/server.ts#createBridgeServer",
  "credential:apps/mcp-server/src/hci-tool-support.ts#hciConnection",
  "credential:apps/mcp-server/src/tower-client.ts#TowerClient",
  "credential:apps/operator-console/src/server.ts#<module>",
  "credential:apps/operator-console/src/server.ts#createOperatorServer",
  "credential:packages/sangfor-collector/src/one-session.ts#loadOneSessionFromEnv",
  "credential:packages/sangfor-competency/src/tool-registry.ts#fetchBridgeToolRegistry",
  "credential:packages/sangfor-competency/src/write-authority.ts#resolveConfiguredWriteAuthority",
  "credential:packages/sangfor-hci-client/src/audit-ledger.ts#AuditLedger",
  "credential:packages/sangfor-jm-execution/src/playwright-options.ts#assertOwnedCdpBinding",
  "credential:packages/sangfor-operator/src/gate.ts#verifyRealExecutionAllowed",
  "credential:packages/sangfor-operator/src/hci-authorization.ts#authorizeHciMutation",
  "credential:packages/sangfor-operator/src/iag-evidence-bootstrap.ts#authorizeIagEvidenceBootstrap",
  "credential:packages/sangfor-operator/src/iag-evidence-bootstrap.ts#verifyBootstrapApproval",
  "credential:packages/sangfor-operator/src/iag-mutation-authorization.ts#verifyIagMutationAuthorization",
  "credential:packages/sangfor-pm/src/index.ts#createPmStore",
  "credential:packages/sangfor-rag/src/mimo-config.ts#resolveMimoTokenPlanCluster",
  "credential:packages/sangfor-screenshot/src/console-evidence-verification.ts#verifyCaptureLedger",
  "credential:packages/sangfor-wiki/src/index.ts#approveWikiUpdate",
  "credential:packages/sangfor-wiki/src/index.ts#mintWikiApproval",
  "credential:scripts/capture-one-from-cdp.ts#main",
  "credential:scripts/hci-real-smoke.ts#<module>",
  "credential:scripts/interactive-one-login.ts#main",
  "credential:scripts/kb-login-capture.ts#<module>",
  "credential:scripts/lib/capability-evidence-cli-existing.ts#runExistingCommand",
  "credential:scripts/lib/capability-evidence-cli-stale.ts#runStaleCliCommand",
  "credential:scripts/lib/kb-browser-session.ts#resolveKbBrowserTokens",
  "credential:scripts/mint-hci-approval.ts#<module>",
  "credential:scripts/report-project-completeness.ts#run",
  "credential:scripts/support-collect.ts#<module>",
  "credential:scripts/test-browser-port.ts#localReadBack",
] as const;

export const BROWSER_JOB_AUTHORITY_REFS = [
  "persist:packages/sangfor-authority/src/remote-job-reservation.ts#reserveRemoteJobTransaction",
  "persist:packages/sangfor-authority/src/remote-job-result.ts#markRemoteJobIndeterminateTransaction",
  "persist:packages/sangfor-authority/src/remote-job-result.ts#retainRemoteJobResultTransaction",
  "persist:scripts/lib/blro-two-replica-database.ts#cleanup",
  "persist:scripts/lib/blro-two-replica-database.ts#createHarnessAuthorityDatabase",
  "persist:scripts/lib/blro-two-replica-fixture.ts#createTwoReplicaFixture",
  "prisma:model:BlroRemoteJob",
  "prisma:model:BlroRemoteJobCapabilityJti",
] as const;

export const LOOP_REFS = [
  "persist:packages/sangfor-loop/src/executors/embedding-drift.ts#runEmbeddingDriftExecutor",
  "persist:packages/sangfor-loop/src/executors/gap-queries.ts#runGapQueriesExecutor",
  "persist:packages/sangfor-loop/src/index.ts#runLoopTick",
] as const;

/**
 * The JM-side refusal journal. It is a disposable, hash-chained local record of
 * what JM already reserved; it holds no secret and is never an authority source,
 * so it is excluded from the authoritative target set.
 */
export const JM_REFUSAL_JOURNAL_REFS = [
  "persist:packages/sangfor-jm-agent/src/journal-storage.ts#appendDurably",
  "persist:packages/sangfor-jm-agent/src/journal-storage.ts#createJournalExclusively",
] as const;

export const ACQUISITION_REFS = [
  "persist:packages/sangfor-collector/src/capture-bundle.ts#promoteCapturePayload",
  "persist:packages/sangfor-collector/src/capture-bundle.ts#writeAtomic",
  "persist:packages/sangfor-collector/src/capture-bundle.ts#writeCaptureBundle",
  "persist:packages/sangfor-collector/src/index.ts#saveCollectedDocuments",
  "persist:packages/sangfor-collector/src/index.ts#saveCollectedManifest",
  "persist:packages/sangfor-collector/src/site-learning-crawler.ts#runTwoSiteLearning",
  "persist:packages/sangfor-collector/src/site-learning-crawler.ts#saveCheckpoint",
] as const;

export const IAG_REFS = [
  "persist:packages/sangfor-product-adapters/src/operator/store-checkpoint.ts#IagCheckpointStore",
  "persist:packages/sangfor-product-adapters/src/operator/store-seal.ts#IagIndeterminateSealStore",
  "persist:packages/sangfor-product-adapters/src/operator/store.ts#FileIagOrchestratorStore",
] as const;

export const LEGACY_REFS = [
  "prisma:model:SangforManual",
] as const;

