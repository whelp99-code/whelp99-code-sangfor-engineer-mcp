-- Additive learning-strategy metadata mirror. The local file store remains canonical.
CREATE TABLE "LearningMethodCatalog" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "contentDigest" TEXT NOT NULL,
    "coverage" JSONB,
    "latencyMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LearningMethodCatalog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LearningFirmwareProfile" (
    "id" TEXT NOT NULL,
    "firmwareTruthId" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "productCode" TEXT NOT NULL,
    "productVariant" TEXT,
    "versionRaw" TEXT NOT NULL,
    "specVersion" TEXT,
    "registryDigest" TEXT NOT NULL,
    "uiFingerprint" TEXT,
    "apiFingerprint" TEXT,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LearningFirmwareProfile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LearningStrategyRevision" (
    "revisionId" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "contentDigest" TEXT NOT NULL,
    "evidenceDigest" TEXT,
    "methodCodes" JSONB,
    "deviceScopeDigest" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "mirroredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LearningStrategyRevision_pkey" PRIMARY KEY ("revisionId")
);

CREATE TABLE "LearningLifecycleEvent" (
    "eventId" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "fromState" TEXT,
    "toState" TEXT NOT NULL,
    "evidenceDigest" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "mirroredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LearningLifecycleEvent_pkey" PRIMARY KEY ("eventId")
);

CREATE TABLE "LearningEvidence" (
    "evidenceId" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "coverage" JSONB,
    "latencyMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "mirroredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LearningEvidence_pkey" PRIMARY KEY ("evidenceId")
);

CREATE TABLE "LearningRun" (
    "runId" TEXT NOT NULL,
    "strategyId" TEXT,
    "revisionId" TEXT,
    "methodCode" TEXT,
    "status" TEXT NOT NULL,
    "coverage" JSONB,
    "latencyMs" INTEGER,
    "deviceScopeDigest" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "mirroredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LearningRun_pkey" PRIMARY KEY ("runId")
);

CREATE TABLE "LearningMirrorReceipt" (
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payloadDigest" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "mirroredAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LearningMirrorReceipt_pkey" PRIMARY KEY ("eventId")
);

CREATE UNIQUE INDEX "LearningMethodCatalog_revisionId_key" ON "LearningMethodCatalog"("revisionId");
CREATE UNIQUE INDEX "LearningFirmwareProfile_firmwareTruthId_key" ON "LearningFirmwareProfile"("firmwareTruthId");
CREATE UNIQUE INDEX "LearningEvidence_digest_key" ON "LearningEvidence"("digest");
CREATE INDEX "LearningStrategyRevision_strategyId_createdAt_idx" ON "LearningStrategyRevision"("strategyId", "createdAt");
CREATE INDEX "LearningLifecycleEvent_strategyId_occurredAt_idx" ON "LearningLifecycleEvent"("strategyId", "occurredAt");
