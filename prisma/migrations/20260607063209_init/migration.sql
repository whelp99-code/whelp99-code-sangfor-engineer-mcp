-- CreateTable
CREATE TABLE "SangforProduct" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priority" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SangforProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SangforManual" (
    "id" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "version" TEXT,
    "title" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "filePath" TEXT,
    "trustLevel" TEXT NOT NULL DEFAULT 'needs_review',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SangforManual_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SangforProject" (
    "id" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "version" TEXT,
    "projectType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SangforProject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SangforConfigPlan" (
    "id" TEXT NOT NULL,
    "projectId" TEXT,
    "product" TEXT NOT NULL,
    "planTitle" TEXT NOT NULL,
    "planJson" JSONB NOT NULL,
    "riskLevel" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SangforConfigPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SangforFeedbackEvent" (
    "id" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "feedbackType" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "feedbackText" TEXT NOT NULL,
    "sourceRole" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'new',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SangforFeedbackEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SangforWikiUpdateProposal" (
    "id" TEXT NOT NULL,
    "targetPage" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "beforeText" TEXT NOT NULL,
    "afterText" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SangforWikiUpdateProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SangforRagDocument" (
    "id" TEXT NOT NULL,
    "productCode" TEXT NOT NULL,
    "version" TEXT,
    "title" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SangforRagDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SangforRagChunk" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "productCode" TEXT NOT NULL,
    "version" TEXT,
    "title" TEXT NOT NULL,
    "section" TEXT,
    "chunkText" TEXT NOT NULL,
    "vector" JSONB,
    "contentHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SangforRagChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SangforFineTuneDataset" (
    "id" TEXT NOT NULL,
    "productCode" TEXT NOT NULL,
    "taskType" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "exampleCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SangforFineTuneDataset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SangforFineTuneJob" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "baseModel" TEXT NOT NULL,
    "datasetPath" TEXT NOT NULL,
    "productCode" TEXT NOT NULL,
    "taskType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ready_for_review',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SangforFineTuneJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SangforProduct_code_key" ON "SangforProduct"("code");

-- CreateIndex
CREATE UNIQUE INDEX "SangforRagDocument_contentHash_key" ON "SangforRagDocument"("contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "SangforRagChunk_contentHash_key" ON "SangforRagChunk"("contentHash");

-- AddForeignKey
ALTER TABLE "SangforRagChunk" ADD CONSTRAINT "SangforRagChunk_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "SangforRagDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
