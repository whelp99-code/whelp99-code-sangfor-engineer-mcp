import { PrismaClient } from '@prisma/client';
import type { ConfigPlan } from '@sangfor/shared';

let client: PrismaClient | undefined;

export function isStoreEnabled(): boolean {
  if (process.env.SANGFOR_DB_ENABLED === '0') return false;
  return Boolean(process.env.DATABASE_URL?.trim());
}

export function getPrisma(): PrismaClient | null {
  if (!isStoreEnabled()) return null;
  client ??= new PrismaClient();
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
