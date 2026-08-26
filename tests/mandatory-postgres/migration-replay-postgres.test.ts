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
    WHERE c.relname='BlroSourceRootOwner_projectId_idx'
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

  it('keeps the complete replay sequence catalog-stable', async () => {
    expect(await catalogSnapshot()).toEqual(before);
  });
});
