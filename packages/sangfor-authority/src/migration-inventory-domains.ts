export const PM_REFS = [
  "persist:apps/control-tower/src/playbook-store.ts#AgentTaskStore",
  "persist:packages/sangfor-authority/src/cutover/domain-targets.ts#PmTaskCutoverTarget",
  "prisma:model:BlroPmRecord",
  "prisma:model:SangforProject",
] as const;

export const FEEDBACK_REFS = [
  "persist:packages/sangfor-feedback/src/index.ts#extractLesson",
  "persist:packages/sangfor-feedback/src/index.ts#submitFeedback",
  "persist:packages/sangfor-authority/src/cutover/domain-targets.ts#FeedbackCutoverTarget",
  "prisma:model:BlroFeedbackLesson",
  "prisma:model:SangforFeedbackEvent",
] as const;

export const EVALS_REFS = [
  "persist:packages/sangfor-evals/src/index.ts#createEvalCaseFromFeedback",
  "persist:packages/sangfor-authority/src/cutover/domain-targets.ts#EvalCutoverTarget",
  "prisma:model:BlroEvalRecord",
] as const;

export const WIKI_REFS = [
  "persist:packages/sangfor-wiki/src/index.ts#GitHubWikiGitAdapter",
  "persist:packages/sangfor-wiki/src/index.ts#ObsidianVaultAdapter",
  "persist:packages/sangfor-wiki/src/index.ts#applyWikiUpdate",
  "persist:packages/sangfor-wiki/src/index.ts#applyWikiUpdateWithAdapter",
  "persist:packages/sangfor-wiki/src/index.ts#approveWikiUpdate",
  "persist:packages/sangfor-wiki/src/index.ts#proposeWikiUpdate",
  "persist:packages/sangfor-wiki/src/index.ts#saveCard",
  "persist:packages/sangfor-wiki/src/index.ts#saveProposal",
  "persist:packages/sangfor-wiki/src/index.ts#upsertKnowledgeCard",
  "persist:packages/sangfor-authority/src/cutover/domain-targets.ts#WikiCutoverTarget",
  "prisma:model:BlroWikiProposal",
  "prisma:model:SangforWikiUpdateProposal",
] as const;

export const FIRMWARE_REFS = [
  "prisma:model:BlroFirmwareEvidence",
  "prisma:model:LearningFirmwareProfile",
] as const;

export const LEARNING_REFS = [
  "persist:scripts/learning-strategy-driver.ts#main",
  "persist:packages/sangfor-learning-strategy/src/store.ts#StrategyStoreManager",
  "persist:packages/sangfor-learning-strategy/src/store.ts#writeFileAtomic",
  "persist:packages/sangfor-authority/src/cutover/domain-targets.ts#LearningCutoverTarget",
  "prisma:model:BlroLearningRecord",
  "prisma:model:LearningEvidence",
  "prisma:model:LearningLifecycleEvent",
  "prisma:model:LearningMethodCatalog",
  "prisma:model:LearningMirrorReceipt",
  "prisma:model:LearningRun",
  "prisma:model:LearningStrategyRevision",
] as const;

export const CONFIG_REFS = [
  "persist:packages/sangfor-chronicle/src/store.ts#recordSnapshot",
  "persist:packages/sangfor-authority/src/cutover/domain-targets.ts#ChronicleCutoverTarget",
  "prisma:model:BlroConfigChronicle",
  "prisma:model:SangforConfigPlan",
] as const;

export const CAPABILITY_REFS = [
  "persist:packages/sangfor-competency/src/promotion-checkpoint.ts#initializePromotionStore",
  "persist:packages/sangfor-competency/src/promotion-checkpoint.ts#writePromotionCheckpoint",
  "persist:packages/sangfor-competency/src/promotion-ledger.ts#FilePromotionLedger",
  "persist:packages/sangfor-authority/src/cutover/domain-targets.ts#CapabilityCutoverTarget",
  "prisma:model:BlroCapabilityEvidence",
] as const;
