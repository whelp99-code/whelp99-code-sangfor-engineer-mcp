import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { canonicalPromotionJson } from '../../packages/sangfor-rag/src/index-promotion-evaluator.js';
import { IndexPromotionRouter } from '../../packages/sangfor-rag/src/index-promotion-router.js';
import { IndexPromotionStore } from '../../packages/sangfor-rag/src/index-promotion-store.js';
import { IndexPromotionReportSchema } from '../../packages/sangfor-rag/src/index-promotion-types.js';
import { hashEmbedding } from '../../packages/sangfor-rag/src/hash-embedding.js';
import { parsePgvectorCohort, parsePgvectorScope } from '../../packages/sangfor-rag/src/pgvector-schema.js';
import { PgvectorRagStore } from '../../packages/sangfor-rag/src/pgvector-store.js';
import type { PgvectorDatabase, PgvectorScope } from '../../packages/sangfor-rag/src/pgvector-types.js';
import { promotionFixture } from './rag-promotion-postgres.js';

type Authority = { readonly actorId: string; readonly secret: string };
type ScenarioInput = {
  readonly database: PgvectorDatabase;
  readonly owner: PrismaClient;
  readonly scope: PgvectorScope;
  readonly authority: Authority;
  readonly nonceA: string;
  readonly nonceB: string;
};

type Rejection = { readonly status: 'rejected'; readonly reason: unknown };
const NonceRowSchema = z.object({ nonce: z.string() }).strict();

function refusalCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code : undefined;
}

function loadedDigest(raw: unknown): string | undefined {
  const parsed = IndexPromotionReportSchema.safeParse(raw);
  return parsed.success ? parsed.data.reportDigest : undefined;
}

async function mutationRefused(
  database: PgvectorDatabase,
  scope: PgvectorScope,
  query: string,
  ...values: readonly unknown[]
): Promise<boolean> {
  try {
    await database.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, scope.projectId);
      await transaction.$executeRawUnsafe(query, ...values);
    });
    return false;
  } catch (error) {
    return error instanceof Error
      && error.message.includes('BLRO_RAG_INDEX_PROMOTION_EVIDENCE_APPEND_ONLY');
  }
}

async function routeReason(store: IndexPromotionStore, scope: PgvectorScope): Promise<string> {
  const routed = await new IndexPromotionRouter(store).search(
    { scope, query: hashEmbedding('oracle'), filters: {}, limit: 1 },
    { backend: 'auto', now: new Date() },
  );
  return routed.diagnostics.reason;
}

export async function exercisePromotionHistory(input: ScenarioInput) {
  const promotion = new IndexPromotionStore(input.database, { promotionAuthority: input.authority });
  const first = await promotionFixture({
    promotion, scope: input.scope, authority: input.authority, nonce: input.nonceA,
  });
  await promotion.apply({ scope: input.scope, evidence: first.evidence, now: first.now, reason: 'history A' });
  const second = await promotionFixture({
    promotion, scope: input.scope, authority: input.authority, nonce: input.nonceB,
  });
  await promotion.apply({ scope: input.scope, evidence: second.evidence, now: second.now, reason: 'history B' });
  let oldReplayCode: string | undefined;
  try {
    await promotion.apply({ scope: input.scope, evidence: first.evidence, now: second.now, reason: 'old replay' });
  } catch (error) {
    oldReplayCode = refusalCode(error);
  }
  const concurrent = await Promise.allSettled([
    promotion.apply({ scope: input.scope, evidence: first.evidence, now: second.now, reason: 'concurrent A' }),
    promotion.apply({ scope: input.scope, evidence: second.evidence, now: second.now, reason: 'concurrent B' }),
  ]);
  const concurrentCodes = concurrent
    .filter((result): result is Rejection => result.status === 'rejected')
    .map((result) => refusalCode(result.reason));
  const restarted = new IndexPromotionStore(input.database, { promotionAuthority: input.authority });
  const restartedDigest = loadedDigest(await restarted.loadPromotion(input.scope));
  const baseHistory = await input.database.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, input.scope.projectId);
    return z.array(NonceRowSchema).parse(await transaction.$queryRawUnsafe<unknown>(`
      SELECT "nonce" FROM "BlroRagIndexPromotionEvidence"
      WHERE "tenantId"=$1 AND "projectId"=$2 AND "nonce" IN ($3,$4) ORDER BY "nonce"`,
    input.scope.tenantId, input.scope.projectId, input.nonceA, input.nonceB));
  });

  const alternateScope = parsePgvectorScope({
    tenantId: 'tenant-alpha', projectId: 'rag-fixture-tenant-alpha-project-alpha', actorId: input.authority.actorId,
  });
  await input.owner.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(
      `INSERT INTO "BlroTenant" ("id","name") VALUES ($1,$2) ON CONFLICT ("id") DO NOTHING`,
      alternateScope.tenantId, 'RAG promotion history tenant',
    );
    await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, alternateScope.projectId);
    await transaction.$executeRawUnsafe(
      `INSERT INTO "BlroProject" ("id","tenantId","name") VALUES ($1,$2,$3) ON CONFLICT ("id") DO NOTHING`,
      alternateScope.projectId, alternateScope.tenantId, 'RAG promotion history project',
    );
  });
  await new PgvectorRagStore(input.database).promoteCohort(parsePgvectorCohort({
    ...alternateScope, id: `cohort-${alternateScope.projectId}`, indexEpoch: 35,
    backend: 'hash', model: 'hash-v1', dimensions: 384,
  }));
  const alternate = await promotionFixture({
    promotion: restarted, scope: alternateScope, authority: input.authority, nonce: first.evidence.nonce,
  });
  await restarted.apply({ scope: alternateScope, evidence: alternate.evidence, now: alternate.now, reason: 'cross-scope nonce' });
  const crossScopeDigest = loadedDigest(await restarted.loadPromotion(alternateScope));
  const crossHistory = await input.database.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, alternateScope.projectId);
    return z.array(NonceRowSchema).parse(await transaction.$queryRawUnsafe<unknown>(`
      SELECT "nonce" FROM "BlroRagIndexPromotionEvidence"
      WHERE "tenantId"=$1 AND "projectId"=$2 ORDER BY "nonce"`, alternateScope.tenantId, alternateScope.projectId));
  });

  await input.owner.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, alternateScope.projectId);
    await transaction.$executeRawUnsafe(`ALTER TABLE "BlroRagIndexPromotionEvidence"
      DISABLE TRIGGER "BlroRagIndexPromotionEvidence_append_only"`);
    await transaction.$executeRawUnsafe(`UPDATE "BlroRagIndexPromotionEvidence" SET "evidenceCanonical"='corrupt'
      WHERE "tenantId"=$1 AND "projectId"=$2 AND "nonce"=$3`, alternateScope.tenantId, alternateScope.projectId, alternate.evidence.nonce);
    await transaction.$executeRawUnsafe(`ALTER TABLE "BlroRagIndexPromotionEvidence"
      ENABLE TRIGGER "BlroRagIndexPromotionEvidence_append_only"`);
  });
  const corruptReason = await routeReason(restarted, alternateScope);
  await input.owner.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, alternateScope.projectId);
    await transaction.$executeRawUnsafe(`ALTER TABLE "BlroRagIndexPromotionEvidence"
      DISABLE TRIGGER "BlroRagIndexPromotionEvidence_append_only"`);
    await transaction.$executeRawUnsafe(`UPDATE "BlroRagIndexPromotionEvidence" SET "evidenceCanonical"=$4
      WHERE "tenantId"=$1 AND "projectId"=$2 AND "nonce"=$3`, alternateScope.tenantId, alternateScope.projectId,
    alternate.evidence.nonce, canonicalPromotionJson(alternate.evidence));
    await transaction.$executeRawUnsafe(`DELETE FROM "BlroRagIndexPromotionEvidence"
      WHERE "tenantId"=$1 AND "projectId"=$2 AND "nonce"=$3`, alternateScope.tenantId, alternateScope.projectId, alternate.evidence.nonce);
    await transaction.$executeRawUnsafe(`ALTER TABLE "BlroRagIndexPromotionEvidence"
      ENABLE TRIGGER "BlroRagIndexPromotionEvidence_append_only"`);
  });
  const missingReason = await routeReason(restarted, alternateScope);
  await input.owner.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, alternateScope.projectId);
    await transaction.$executeRawUnsafe(`INSERT INTO "BlroRagIndexPromotionEvidence"
      ("tenantId","projectId","nonce","cohortId","indexEpoch","authorityActorId","evidence","evidenceCanonical","reportDigest")
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`, alternateScope.tenantId, alternateScope.projectId,
    alternate.evidence.nonce, alternate.report.cohortId, alternate.report.indexEpoch, alternate.evidence.authorityActorId,
    canonicalPromotionJson(alternate.evidence), canonicalPromotionJson(alternate.evidence), alternate.report.reportDigest);
  });

  const historyUpdateRefused = await mutationRefused(input.database, input.scope,
    `UPDATE "BlroRagIndexPromotionEvidence" SET "evidenceCanonical"='attacker-rewrite'
      WHERE "tenantId"=$1 AND "projectId"=$2 AND "nonce"=$3`,
    input.scope.tenantId, input.scope.projectId, input.nonceA);
  const historyDeleteRefused = await mutationRefused(input.database, input.scope,
    `DELETE FROM "BlroRagIndexPromotionEvidence"
      WHERE "tenantId"=$1 AND "projectId"=$2 AND "nonce"=$3`,
    input.scope.tenantId, input.scope.projectId, input.nonceA);
  const promotionDeleteCount = await input.database.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, input.scope.projectId);
    return transaction.$executeRawUnsafe(`DELETE FROM "BlroRagIndexPromotion"
      WHERE "tenantId"=$1 AND "projectId"=$2`, input.scope.tenantId, input.scope.projectId);
  });
  let replayAfterMutationCode: string | undefined;
  try {
    await promotion.apply({ scope: input.scope, evidence: first.evidence, now: second.now, reason: 'mutation replay' });
  } catch (error) {
    replayAfterMutationCode = refusalCode(error);
  }
  const restored = await promotionFixture({
    promotion, scope: input.scope, authority: input.authority, nonce: `${input.nonceB}-restored`,
  });
  await promotion.apply({
    scope: input.scope, evidence: restored.evidence, now: restored.now, reason: 'post-exploit fixture restore',
  });

  return {
    oldReplayCode, concurrentCodes, restartedDigest, baseHistory: baseHistory.map((row) => row.nonce),
    crossScopeDigest, crossHistory: crossHistory.map((row) => row.nonce), corruptReason, missingReason,
    historyUpdateRefused, historyDeleteRefused, promotionDeleteCount, replayAfterMutationCode,
  };
}
