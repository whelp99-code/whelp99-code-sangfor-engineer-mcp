import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { embeddingSpaceId } from '../../packages/sangfor-rag/src/embedding-space.js';
import { PGVECTOR_HASH_EMBEDDING_SPACE } from '../../packages/sangfor-rag/src/pgvector-types.js';

const ownerUrl = process.env['BLRO_OWNER_DATABASE_URL'];
if (!ownerUrl || process.env['SANGFOR_REQUIRE_POSTGRES_TESTS'] !== '1') {
  throw new Error('MANDATORY_POSTGRES_DATABASE_REQUIRED');
}

const RAG_COHORT_CORRECTIVE_MIGRATION =
  'prisma/migrations/20260827190000_fix_rag_cohort_promotion_scope/migration.sql';
const RAG_EMBEDDING_SPACE_MIGRATION =
  'prisma/migrations/20260908010000_rag_embedding_space_contract/migration.sql';
const migrations = [
  'prisma/migrations/20260827010000_todo24_scoped_index/migration.sql',
  'prisma/migrations/20260827010200_todo24_local_intent_ownership/migration.sql',
  'prisma/migrations/20260827010500_todo24_composite_ownership/migration.sql',
  RAG_COHORT_CORRECTIVE_MIGRATION,
  'prisma/migrations/20260831010000_rag_index_promotion_evidence_append_only/migration.sql',
  RAG_EMBEDDING_SPACE_MIGRATION,
] as const;

const database = new PrismaClient({ datasources: { db: { url: ownerUrl } } });

async function catalogSnapshot(): Promise<readonly string[]> {
  const rows = await database.$queryRawUnsafe<Array<{ definition: string }>>(`
    SELECT 'constraint:' || c.conname || ':' || pg_get_constraintdef(c.oid,true) AS definition
    FROM pg_constraint c
    WHERE c.conname LIKE 't24_%' OR c.conname IN (
      'BlroProject_tenantId_id_key',
      'BlroMembership_tenantId_projectId_actorId_key',
      'BlroLocalWriteIntent_projectId_fkey',
      'BlroRagEmbeddingCohort_embedding_space_pair'
    )
    UNION ALL
    SELECT 'index:' || c.relname || ':' || pg_get_indexdef(c.oid) AS definition
    FROM pg_class c
    WHERE c.relname IN (
      'BlroSourceRootOwner_projectId_idx',
      'BlroRagEmbeddingCohort_one_active_scope_key',
      'BlroRagEmbeddingCohort_full_space_identity_key'
    )
    UNION ALL
    SELECT 'trigger:' || t.tgname || ':' || pg_get_triggerdef(t.oid,true) AS definition
    FROM pg_trigger t
    WHERE t.tgname='BlroRagIndexPromotionEvidence_append_only' AND NOT t.tgisinternal
    ORDER BY definition
  `);
  return rows.map((row) => row.definition);
}

describe('Todo 24 migration replay', () => {
  let before: readonly string[];

  beforeAll(async () => { before = await catalogSnapshot(); });
  afterAll(async () => database.$disconnect());

  it.each(migrations)('Given an already upgraded database, When %s is replayed, Then it exits zero without catalog drift', async (migration) => {
    // Given
    const snapshot = await catalogSnapshot();

    // When
    const result = spawnSync(process.env['PSQL_BIN'] ?? 'psql', [ownerUrl, '-v', 'ON_ERROR_STOP=1', '-f', migration], {
      cwd: process.cwd(), encoding: 'utf8',
    });

    // Then
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(await catalogSnapshot()).toEqual(snapshot);
  });

  it('Given active cohorts from multiple epochs, When the corrective migration runs, Then it keeps the newest and restores FORCE RLS', async () => {
    // Given
    const suffix = randomUUID();
    const tenantId = `migration-cohort-tenant-${suffix}`;
    const projectId = `migration-cohort-project-${suffix}`;
    await database.$executeRawUnsafe(`INSERT INTO "BlroTenant" ("id","name") VALUES ($1,'migration cohort')`, tenantId);
    await database.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, projectId);
      await transaction.$executeRawUnsafe(
        `INSERT INTO "BlroProject" ("id","tenantId","name") VALUES ($1,$2,'migration cohort')`,
        projectId, tenantId,
      );
    });
    await database.$executeRawUnsafe(`DROP INDEX "BlroRagEmbeddingCohort_one_active_scope_key"`);
    await database.$executeRawUnsafe(`CREATE UNIQUE INDEX "BlroRagEmbeddingCohort_one_active_epoch_key"
      ON "BlroRagEmbeddingCohort" ("tenantId","projectId","indexEpoch") WHERE "active"`);
    await database.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, projectId);
      await transaction.$executeRawUnsafe(`INSERT INTO "BlroRagEmbeddingCohort"
        ("id","tenantId","projectId","indexEpoch","backend","model","dimensions","active") VALUES
        ('older',$1,$2,10,'hash','hash-v1',384,true),
        ('newer',$1,$2,11,'hash','hash-v1',384,true)`, tenantId, projectId);
    });

    // When
    const result = spawnSync(process.env['PSQL_BIN'] ?? 'psql', [ownerUrl, '-v', 'ON_ERROR_STOP=1', '-f', RAG_COHORT_CORRECTIVE_MIGRATION], {
      cwd: process.cwd(), encoding: 'utf8',
    });

    try {
      // Then
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      const active = await database.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, projectId);
        return transaction.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT "id" FROM "BlroRagEmbeddingCohort" WHERE "projectId"=$1 AND "active" ORDER BY "id"`, projectId,
        );
      });
      expect(active).toEqual([{ id: 'newer' }]);
      expect(await database.$queryRawUnsafe<Array<{ enabled: boolean; forced: boolean; policy: string }>>(
        `SELECT c.relrowsecurity AS enabled,c.relforcerowsecurity AS forced,p.polname AS policy
         FROM pg_class c JOIN pg_policy p ON p.polrelid=c.oid
         WHERE c.relname='BlroRagEmbeddingCohort'`,
      )).toEqual([{ enabled: true, forced: true, policy: 'BlroRagEmbeddingCohort_scope' }]);
    } finally {
      if (result.status !== 0) spawnSync(process.env['PSQL_BIN'] ?? 'psql', [ownerUrl, '-v', 'ON_ERROR_STOP=1', '-f', RAG_COHORT_CORRECTIVE_MIGRATION]);
      await database.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, projectId);
        await transaction.$executeRawUnsafe(`DELETE FROM "BlroRagEmbeddingCohort" WHERE "projectId"=$1`, projectId);
        await transaction.$executeRawUnsafe(`DELETE FROM "BlroProject" WHERE "id"=$1`, projectId);
      });
      await database.$executeRawUnsafe(`DELETE FROM "BlroTenant" WHERE "id"=$1`, tenantId);
    }
  });

  it('deactivates unpinned cohorts and legacy promotions as owner, rejects half-pinned rows, and preserves compatible state on replay', async () => {
    const suffix = randomUUID();
    const tenantId = `embedding-migration-tenant-${suffix}`;
    const projectId = `embedding-migration-project-${suffix}`;
    const legacyCohortId = `embedding-migration-legacy-${suffix}`;
    const compatibleCohortId = `embedding-migration-compatible-${suffix}`;
    const runMigration = () => spawnSync(process.env['PSQL_BIN'] ?? 'psql', [ownerUrl, '-v', 'ON_ERROR_STOP=1', '-f', RAG_EMBEDDING_SPACE_MIGRATION], {
      cwd: process.cwd(), encoding: 'utf8',
    });
    await database.$executeRawUnsafe(`INSERT INTO "BlroTenant" ("id","name") VALUES ($1,'embedding migration')`, tenantId);
    await database.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, projectId);
      await transaction.$executeRawUnsafe(
        `INSERT INTO "BlroProject" ("id","tenantId","name") VALUES ($1,$2,'embedding migration')`,
        projectId, tenantId,
      );
      await transaction.$executeRawUnsafe(`INSERT INTO "BlroRagEmbeddingCohort"
        ("id","tenantId","projectId","indexEpoch","backend","model","dimensions","active")
        VALUES ($1,$2,$3,1,'hash','hash-v1',384,true)`, legacyCohortId, tenantId, projectId);
      await transaction.$executeRawUnsafe(`INSERT INTO "BlroRagIndexPromotion"
        ("tenantId","projectId","cohortId","indexEpoch","report","reportCanonical","reportDigest","state","reason","promotedAt")
        VALUES ($1,$2,$3,1,'{}'::jsonb,'{}',$4,'promoted','legacy',CURRENT_TIMESTAMP)`,
      tenantId, projectId, legacyCohortId, 'a'.repeat(64));
    });

    const migrated = runMigration();
    try {
      expect(migrated.status, `${migrated.stdout}${migrated.stderr}`).toBe(0);
      const repaired = await database.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, projectId);
        return transaction.$queryRawUnsafe<Array<{ active: boolean; state: string; reason: string }>>(`
          SELECT c."active",p."state",p."reason"
          FROM "BlroRagEmbeddingCohort" c JOIN "BlroRagIndexPromotion" p
            ON p."tenantId"=c."tenantId" AND p."projectId"=c."projectId" AND p."cohortId"=c."id"
          WHERE c."tenantId"=$1 AND c."projectId"=$2 AND c."id"=$3`, tenantId, projectId, legacyCohortId);
      });
      expect(repaired).toEqual([{ active: false, state: 'demoted', reason: 'embedding-space-contract-migration' }]);

      await expect(database.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, projectId);
        await transaction.$executeRawUnsafe(`INSERT INTO "BlroRagEmbeddingCohort"
          ("id","tenantId","projectId","indexEpoch","backend","model","dimensions","embeddingSpace","embeddingSpaceDigest","active")
          VALUES ($1,$2,$3,2,'hash','hash',384,'{}'::jsonb,NULL,false)`, `half-pinned-${suffix}`, tenantId, projectId);
      })).rejects.toBeDefined();

      const compatibleReport = {
        schemaVersion: 'rag.index-promotion-evidence/1',
        report: {
          schemaVersion: 'rag.index-promotion/1',
          embeddingSpaceDigest: embeddingSpaceId(PGVECTOR_HASH_EMBEDDING_SPACE),
          benchmarkDigest: 'b'.repeat(64), benchmarkProfileDigest: 'c'.repeat(64),
          benchmarkQueryCount: 16, k: 5, updateMeasured: true, recoveryMeasured: true,
        },
      };
      await database.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, projectId);
        await transaction.$executeRawUnsafe(`INSERT INTO "BlroRagEmbeddingCohort"
          ("id","tenantId","projectId","indexEpoch","backend","model","dimensions","embeddingSpace","embeddingSpaceDigest","active")
          VALUES ($1,$2,$3,2,'hash','hash',384,$4::jsonb,$5,true)`, compatibleCohortId, tenantId, projectId,
        JSON.stringify(PGVECTOR_HASH_EMBEDDING_SPACE), embeddingSpaceId(PGVECTOR_HASH_EMBEDDING_SPACE));
        await transaction.$executeRawUnsafe(`INSERT INTO "BlroRagIndexPromotion"
          ("tenantId","projectId","cohortId","indexEpoch","report","reportCanonical","reportDigest","state","reason","promotedAt")
          VALUES ($1,$2,$3,2,$4::jsonb,$5,$6,'promoted','compatible',CURRENT_TIMESTAMP)`, tenantId, projectId,
        compatibleCohortId, JSON.stringify(compatibleReport), JSON.stringify(compatibleReport), 'd'.repeat(64));
      });
      const replayed = runMigration();
      expect(replayed.status, `${replayed.stdout}${replayed.stderr}`).toBe(0);
      const retained = await database.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, projectId);
        return transaction.$queryRawUnsafe<Array<{ state: string }>>(
          `SELECT "state" FROM "BlroRagIndexPromotion" WHERE "tenantId"=$1 AND "projectId"=$2 AND "cohortId"=$3`,
          tenantId, projectId, compatibleCohortId,
        );
      });
      expect(retained).toEqual([{ state: 'promoted' }]);
      expect(await database.$queryRawUnsafe<Array<{ name: string; forced: boolean }>>(`
        SELECT relname AS "name",relforcerowsecurity AS "forced" FROM pg_class
        WHERE relname IN ('BlroRagEmbeddingCohort','BlroRagIndexPromotion') ORDER BY relname`))
        .toEqual([
          { name: 'BlroRagEmbeddingCohort', forced: true },
          { name: 'BlroRagIndexPromotion', forced: true },
        ]);
    } finally {
      await database.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, projectId);
        await transaction.$executeRawUnsafe(`DELETE FROM "BlroRagIndexPromotion" WHERE "tenantId"=$1 AND "projectId"=$2`, tenantId, projectId);
        await transaction.$executeRawUnsafe(`DELETE FROM "BlroRagEmbeddingCohort" WHERE "tenantId"=$1 AND "projectId"=$2`, tenantId, projectId);
        await transaction.$executeRawUnsafe(`DELETE FROM "BlroProject" WHERE "id"=$1`, projectId);
      });
      await database.$executeRawUnsafe(`DELETE FROM "BlroTenant" WHERE "id"=$1`, tenantId);
    }
  });

  it('keeps the complete replay sequence catalog-stable', async () => {
    expect(await catalogSnapshot()).toEqual(before);
  });
});
