import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ownerUrl = process.env['BLRO_OWNER_DATABASE_URL'];
if (!ownerUrl || process.env['SANGFOR_REQUIRE_POSTGRES_TESTS'] !== '1') {
  throw new Error('MANDATORY_POSTGRES_DATABASE_REQUIRED');
}

const migrations = [
  'prisma/migrations/20260827010000_todo24_scoped_index/migration.sql',
  'prisma/migrations/20260827010200_todo24_local_intent_ownership/migration.sql',
  'prisma/migrations/20260827010500_todo24_composite_ownership/migration.sql',
  'prisma/migrations/20260827190000_fix_rag_cohort_promotion_scope/migration.sql',
] as const;

const database = new PrismaClient({ datasources: { db: { url: ownerUrl } } });

async function catalogSnapshot(): Promise<readonly string[]> {
  const rows = await database.$queryRawUnsafe<Array<{ definition: string }>>(`
    SELECT 'constraint:' || c.conname || ':' || pg_get_constraintdef(c.oid,true) AS definition
    FROM pg_constraint c
    WHERE c.conname LIKE 't24_%' OR c.conname IN (
      'BlroProject_tenantId_id_key',
      'BlroMembership_tenantId_projectId_actorId_key',
      'BlroLocalWriteIntent_projectId_fkey'
    )
    UNION ALL
    SELECT 'index:' || c.relname || ':' || pg_get_indexdef(c.oid) AS definition
    FROM pg_class c
    WHERE c.relname IN (
      'BlroSourceRootOwner_projectId_idx',
      'BlroRagEmbeddingCohort_one_active_scope_key'
    )
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
    const migration = migrations.at(-1);
    if (!migration) throw new TypeError('CORRECTIVE_MIGRATION_MISSING');
    const result = spawnSync(process.env['PSQL_BIN'] ?? 'psql', [ownerUrl, '-v', 'ON_ERROR_STOP=1', '-f', migration], {
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
      if (result.status !== 0) spawnSync(process.env['PSQL_BIN'] ?? 'psql', [ownerUrl, '-v', 'ON_ERROR_STOP=1', '-f', migration]);
      await database.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, projectId);
        await transaction.$executeRawUnsafe(`DELETE FROM "BlroRagEmbeddingCohort" WHERE "projectId"=$1`, projectId);
        await transaction.$executeRawUnsafe(`DELETE FROM "BlroProject" WHERE "id"=$1`, projectId);
      });
      await database.$executeRawUnsafe(`DELETE FROM "BlroTenant" WHERE "id"=$1`, tenantId);
    }
  });

  it('keeps the complete replay sequence catalog-stable', async () => {
    expect(await catalogSnapshot()).toEqual(before);
  });
});
