import { createRequire } from 'node:module';
import type { PrismaClient } from '@prisma/client';
import type { ConfigPlan } from '@sangfor/shared';
import {
  syncStrategyMirror,
  type LearningMirrorAdapter,
  type LearningMirrorOutboxEvent,
  type LearningMirrorSyncResult,
  type StrategyStoreManager,
} from '../../sangfor-learning-strategy/src/index.js';

let client: PrismaClient | undefined;

const requireModule = createRequire(import.meta.url);

export function isStoreEnabled(): boolean {
  if (process.env.SANGFOR_DB_ENABLED === '0') return false;
  return Boolean(process.env.DATABASE_URL?.trim());
}

export function getPrisma(): PrismaClient | null {
  if (!isStoreEnabled()) return null;
  // Lazy-require, never a top-level import: loading @prisma/client eagerly runs
  // its dotenv side effect, which loads the repo-root .env into process.env for
  // EVERY importer of this package (the MCP server pulls sangfor-store at module
  // scope). That silently defeated the "honor .env only for a SERVING process"
  // guard in apps/mcp-server and leaked real SANGFOR_HCI_* credentials into the
  // hermetic HCI mock tests (Keystone 401). Load Prisma only when the store is
  // actually enabled and first used.
  client ??= new (requireModule('@prisma/client') as typeof import('@prisma/client')).PrismaClient();
  return client;
}

export async function disconnectStore(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = undefined;
  }
}

export async function persistConfigPlan(plan: ConfigPlan, projectId?: string): Promise<string | null> {
  const db = getPrisma();
  if (!db) return null;
  const row = await db.sangforConfigPlan.create({
    data: {
      projectId: projectId ?? null,
      product: plan.product,
      planTitle: plan.planTitle,
      planJson: plan as unknown as object,
      riskLevel: plan.riskLevel,
      status: 'draft'
    }
  });
  return row.id;
}

export async function persistFeedbackEvent(input: {
  product: string;
  feedbackType: string;
  severity: string;
  feedbackText: string;
  sourceRole: string;
}): Promise<string | null> {
  const db = getPrisma();
  if (!db) return null;
  const row = await db.sangforFeedbackEvent.create({
    data: {
      product: input.product,
      feedbackType: input.feedbackType,
      severity: input.severity,
      feedbackText: input.feedbackText,
      sourceRole: input.sourceRole,
      status: 'new'
    }
  });
  return row.id;
}

export async function upsertRagDocumentMeta(input: {
  productCode: string;
  version?: string;
  title: string;
  sourceType: string;
  filePath: string;
  contentHash: string;
}): Promise<string | null> {
  const db = getPrisma();
  if (!db) return null;
  const row = await db.sangforRagDocument.upsert({
    where: { contentHash: input.contentHash },
    create: {
      productCode: input.productCode,
      version: input.version ?? null,
      title: input.title,
      sourceType: input.sourceType,
      filePath: input.filePath,
      contentHash: input.contentHash
    },
    update: {
      title: input.title,
      filePath: input.filePath,
      version: input.version ?? null
    }
  });
  return row.id;
}

export async function storeHealthCheck(): Promise<{ ok: boolean; detail?: string }> {
  const db = getPrisma();
  if (!db) return { ok: false, detail: 'disabled' };
  try {
    await db.$queryRaw`SELECT 1`;
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: String(err) };
  }
}

function requireMirrorString(event: LearningMirrorOutboxEvent, key: keyof LearningMirrorOutboxEvent['metadata']): string {
  const value = event.metadata[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`MIRROR_EVENT_INVALID: ${String(key)} is required.`);
  return value;
}

export function createPrismaLearningMirrorAdapter(db: PrismaClient | null = getPrisma()): LearningMirrorAdapter {
  return {
    async upsert(event) {
      if (!db) throw new Error('MIRROR_DB_UNAVAILABLE');
      const mirroredAt = new Date().toISOString();
      await db.$transaction(async (transaction) => {
        if (event.eventType === 'strategy_revision') {
          const revisionId = requireMirrorString(event, 'revisionId');
          const strategyId = requireMirrorString(event, 'strategyId');
          const state = requireMirrorString(event, 'state');
          const contentDigest = requireMirrorString(event, 'contentDigest');
          const data = {
            strategyId,
            state,
            contentDigest,
            evidenceDigest: event.metadata.evidenceDigest ?? null,
            methodCodes: event.metadata.methodCodes ?? undefined,
            deviceScopeDigest: event.metadata.deviceScopeDigest ?? null,
            createdAt: new Date(event.occurredAt),
            mirroredAt: new Date(mirroredAt),
          };
          await transaction.learningStrategyRevision.upsert({
            where: { revisionId },
            create: { revisionId, ...data },
            update: data,
          });
        } else if (event.eventType === 'lifecycle_event') {
          const strategyId = requireMirrorString(event, 'strategyId');
          const revisionId = requireMirrorString(event, 'revisionId');
          const toState = requireMirrorString(event, 'state');
          await transaction.learningLifecycleEvent.upsert({
            where: { eventId: event.eventId },
            create: {
              eventId: event.eventId, strategyId, revisionId, eventType: event.eventType,
              toState, evidenceDigest: event.metadata.evidenceDigest ?? null,
              occurredAt: new Date(event.occurredAt), mirroredAt: new Date(mirroredAt),
            },
            update: { toState, evidenceDigest: event.metadata.evidenceDigest ?? null, mirroredAt: new Date(mirroredAt) },
          });
        } else if (event.eventType === 'evidence') {
          const digest = requireMirrorString(event, 'evidenceDigest');
          await transaction.learningEvidence.upsert({
            where: { digest },
            create: {
              evidenceId: event.eventId, digest, kind: 'strategy', status: event.metadata.status ?? 'verified',
              coverage: event.metadata.coverage ?? undefined, latencyMs: event.metadata.latencyMs ?? null,
              createdAt: new Date(event.occurredAt), mirroredAt: new Date(mirroredAt),
            },
            update: { status: event.metadata.status ?? 'verified', coverage: event.metadata.coverage ?? undefined,
              latencyMs: event.metadata.latencyMs ?? null, mirroredAt: new Date(mirroredAt) },
          });
        } else if (event.eventType === 'run') {
          await transaction.learningRun.upsert({
            where: { runId: event.eventId },
            create: {
              runId: event.eventId, strategyId: event.metadata.strategyId ?? null, revisionId: event.metadata.revisionId ?? null,
              methodCode: event.metadata.methodCode ?? null, status: event.metadata.status ?? 'complete', coverage: event.metadata.coverage ?? undefined,
              latencyMs: event.metadata.latencyMs ?? null, deviceScopeDigest: event.metadata.deviceScopeDigest ?? null,
              startedAt: new Date(event.occurredAt), completedAt: event.metadata.completedAt ? new Date(event.metadata.completedAt) : null,
              mirroredAt: new Date(mirroredAt),
            },
            update: { status: event.metadata.status ?? 'complete', coverage: event.metadata.coverage ?? undefined,
              latencyMs: event.metadata.latencyMs ?? null, mirroredAt: new Date(mirroredAt) },
          });
        } else if (event.eventType === 'method_catalog') {
          const revisionId = requireMirrorString(event, 'revisionId');
          await transaction.learningMethodCatalog.upsert({
            where: { revisionId },
            create: {
              code: requireMirrorString(event, 'methodCode'), revisionId,
              status: event.metadata.status ?? 'draft', contentDigest: requireMirrorString(event, 'contentDigest'),
              coverage: event.metadata.coverage ?? undefined, latencyMs: event.metadata.latencyMs ?? null,
            },
            update: { status: event.metadata.status ?? 'draft', contentDigest: requireMirrorString(event, 'contentDigest'),
              coverage: event.metadata.coverage ?? undefined, latencyMs: event.metadata.latencyMs ?? null },
          });
        } else if (event.eventType === 'firmware_profile') {
          const firmwareTruthId = requireMirrorString(event, 'revisionId');
          await transaction.learningFirmwareProfile.upsert({
            where: { firmwareTruthId },
            create: {
              firmwareTruthId, vendor: requireMirrorString(event, 'vendor'), productCode: requireMirrorString(event, 'productCode'),
              productVariant: event.metadata.productVariant ?? null, versionRaw: requireMirrorString(event, 'versionRaw'),
              specVersion: event.metadata.specVersion ?? null, registryDigest: requireMirrorString(event, 'registryDigest'),
              uiFingerprint: event.metadata.uiFingerprint ?? null, apiFingerprint: event.metadata.apiFingerprint ?? null,
              status: event.metadata.status ?? 'candidate',
            },
            update: { registryDigest: requireMirrorString(event, 'registryDigest'), status: event.metadata.status ?? 'candidate' },
          });
        }
        await transaction.learningMirrorReceipt.upsert({
          where: { eventId: event.eventId },
          create: { eventId: event.eventId, eventType: event.eventType, payloadDigest: event.payloadDigest,
            status: 'mirrored', mirroredAt: new Date(mirroredAt) },
          update: { payloadDigest: event.payloadDigest, status: 'mirrored', mirroredAt: new Date(mirroredAt) },
        });
      });
      return { mirroredAt };
    },
  };
}

export async function syncLearningMirrorToPrisma(manager: StrategyStoreManager): Promise<LearningMirrorSyncResult> {
  return await syncStrategyMirror(manager, createPrismaLearningMirrorAdapter());
}
