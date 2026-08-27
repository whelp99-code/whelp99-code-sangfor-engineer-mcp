// Deterministic PostgreSQL publication races for the BLRO backup.
// Promise barriers mark the exported-snapshot boundary; no timing delays or polling are used.
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseBackupCli, runBackup } from '../scripts/blro-backup.mjs';
import { parseManifest } from '../scripts/lib/blro-backup-manifest.mjs';

const ownerUrl = process.env.BLRO_OWNER_DATABASE_URL;
const adminUrl = process.env.BLRO_SCRATCH_ADMIN_DATABASE_URL;
const backupUrl = process.env.BLRO_BACKUP_DATABASE_URL;
// Under the mandatory PostgreSQL profile this suite must never self-skip: a silent skip
// is indistinguishable from coverage. Outside that profile it still degrades to a skip so
// a developer without a cluster is not blocked.
if (process.env.SANGFOR_REQUIRE_POSTGRES_TESTS === '1' && !(ownerUrl && adminUrl && backupUrl)) {
  throw new Error('MANDATORY_POSTGRES_BACKUP_AND_SCRATCH_REQUIRED');
}
const describeDatabase = ownerUrl && adminUrl && backupUrl ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const tenantId = `backup-race-tenant-${suffix}`;
const projectId = `backup-race-project-${suffix}`;
const verificationDatabase = `blro_scratch_backup_verify_race_${suffix}`;
const sourceDatabase = `blro_backup_race_${suffix}`;
const quietObserver = {
  writeOutput: (_text: string): void => undefined,
  writeError: (_text: string): void => undefined,
} as const;

let root = '';
let backupDir = '';
let keyPath = '';
let backupSourceUrl = '';
let originalBackupUrl: string | undefined;
let clusterAdmin: PrismaClient;
let sourceAdmin: PrismaClient;
let owner: PrismaClient;

function databaseUrl(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function options(backupId: string) {
  return parseBackupCli([
    '--out', backupDir, '--signing-key', keyPath, '--backup-id', backupId, '--apply',
    '--verification-scratch-target', `${adminUrl?.replace(/\/[^/]*$/u, '')}/${verificationDatabase}`,
  ]);
}

function manifest(backupId: string) {
  return parseManifest(readFileSync(join(backupDir, `${backupId}.manifest.json`), 'utf8'));
}

async function insertRaceState(migrationName: string, rowId: string): Promise<void> {
  await owner.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, projectId);
    await tx.$executeRawUnsafe(
      `INSERT INTO "_prisma_migrations" (id,checksum,finished_at,migration_name,started_at,applied_steps_count) VALUES ($1,$2,now(),$3,now(),1)`,
      randomUUID(), 'a'.repeat(64), migrationName,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO "BlroWikiProposal" ("id","tenantId","projectId","kind","payload") VALUES ($1,$2,$3,'race',$4::jsonb)`,
      rowId, tenantId, projectId, JSON.stringify({ migrationName }),
    );
  }, { maxWait: 10_000, timeout: 60_000 });
}

async function deleteRaceState(migrationName: string, rowId: string): Promise<void> {
  await sourceAdmin.$transaction([
    sourceAdmin.$executeRawUnsafe(`DELETE FROM "BlroWikiProposal" WHERE "id"=$1`, rowId),
    sourceAdmin.$executeRawUnsafe(`DELETE FROM "_prisma_migrations" WHERE migration_name=$1`, migrationName),
  ]);
}

async function scratchCount(): Promise<number> {
  const rows = await clusterAdmin.$queryRawUnsafe<Array<{ count: number }>>(
    `SELECT count(*)::int AS count FROM pg_database WHERE datname=$1`, verificationDatabase,
  );
  return rows[0]?.count ?? -1;
}

describeDatabase('BLRO backup publication snapshot and scratch equality', () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'blro-backup-race-'));
    backupDir = join(root, 'published');
    mkdirSync(backupDir);
    keyPath = join(root, 'signing.pem');
    writeFileSync(keyPath, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), { mode: 0o600 });
    const requiredAdminUrl = adminUrl ?? '';
    const requiredOwnerUrl = ownerUrl ?? '';
    backupSourceUrl = databaseUrl(backupUrl ?? '', sourceDatabase);
    const ownerSourceUrl = databaseUrl(requiredOwnerUrl, sourceDatabase);
    clusterAdmin = new PrismaClient({ datasources: { db: { url: requiredAdminUrl } } });
    await clusterAdmin.$executeRawUnsafe(`CREATE DATABASE "${sourceDatabase}" OWNER blro_owner`);
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: ownerSourceUrl }, stdio: 'pipe',
    });
    sourceAdmin = new PrismaClient({ datasources: { db: { url: databaseUrl(requiredAdminUrl, sourceDatabase) } } });
    await sourceAdmin.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO blro_backup`);
    await sourceAdmin.$executeRawUnsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO blro_backup`);
    owner = new PrismaClient({ datasources: { db: { url: ownerSourceUrl } } });
    originalBackupUrl = process.env.BLRO_BACKUP_DATABASE_URL;
    process.env.BLRO_BACKUP_DATABASE_URL = backupSourceUrl;
    await sourceAdmin.$executeRawUnsafe(
      `INSERT INTO "BlroTenant" ("id","name") VALUES ($1,'backup race')`, tenantId,
    );
    await sourceAdmin.$executeRawUnsafe(
      `INSERT INTO "BlroProject" ("id","tenantId","name") VALUES ($1,$2,'backup race')`, projectId, tenantId,
    );
  });

  afterAll(async () => {
    await owner?.$disconnect();
    await sourceAdmin?.$disconnect();
    await clusterAdmin?.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${sourceDatabase}" WITH (FORCE)`);
    await clusterAdmin?.$disconnect();
    if (originalBackupUrl === undefined) delete process.env.BLRO_BACKUP_DATABASE_URL;
    else process.env.BLRO_BACKUP_DATABASE_URL = originalBackupUrl;
    rmSync(root, { recursive: true, force: true });
  });

  it('includes a migration and authoritative row committed before the exported snapshot', async () => {
    // Given a commit before snapshot export; When published; Then manifest and restored draft include it.
    const migrationName = `race_before_${suffix}`;
    const rowId = `race-before-${suffix}`;
    await insertRaceState(migrationName, rowId);
    try {
      await runBackup(options('race-before'), quietObserver);
      const published = manifest('race-before');
      expect(published.schema.migrations.some((migration) => migration.name === migrationName)).toBe(true);
      expect(published.tables.find((table) => table.table === 'BlroWikiProposal')?.rowCount).toBe(1);
      expect(await scratchCount()).toBe(0);
    } finally {
      await deleteRaceState(migrationName, rowId);
    }
  }, 180_000);

  it('excludes one transaction committed after the exported snapshot from manifest and dump', async () => {
    // Given WikiProposal locked at the boundary; When its migration and row commit after export;
    // Then the frozen manifest and pg_dump snapshot both exclude that transaction.
    const migrationName = `race_after_${suffix}`;
    const rowId = `race-after-${suffix}`;
    let releaseLock = (): void => undefined;
    let lockReady = (): void => undefined;
    const release = new Promise<void>((resolve) => { releaseLock = resolve; });
    const ready = new Promise<void>((resolve) => { lockReady = resolve; });
    const locker = sourceAdmin.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`LOCK TABLE "BlroWikiProposal" IN ACCESS EXCLUSIVE MODE`);
      lockReady();
      await release;
    }, { maxWait: 10_000, timeout: 60_000 });
    await ready;
    try {
      await runBackup(options('race-after'), {
        ...quietObserver,
        onSnapshotExported: async () => {
          let writerAtLock = (): void => undefined;
          const atLock = new Promise<void>((resolve) => { writerAtLock = resolve; });
          const writer = owner.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, projectId);
            await tx.$executeRawUnsafe(
              `INSERT INTO "_prisma_migrations" (id,checksum,finished_at,migration_name,started_at,applied_steps_count) VALUES ($1,$2,now(),$3,now(),1)`,
              randomUUID(), 'b'.repeat(64), migrationName,
            );
            writerAtLock();
            await tx.$executeRawUnsafe(
              `INSERT INTO "BlroWikiProposal" ("id","tenantId","projectId","kind","payload") VALUES ($1,$2,$3,'race',$4::jsonb)`,
              rowId, tenantId, projectId, JSON.stringify({ migrationName }),
            );
          }, { maxWait: 10_000, timeout: 60_000 });
          await atLock;
          releaseLock();
          await locker;
          await writer;
        },
      });
      const published = manifest('race-after');
      expect(published.schema.migrations.some((migration) => migration.name === migrationName)).toBe(false);
      expect(published.tables.find((table) => table.table === 'BlroWikiProposal')?.rowCount).toBe(0);
      expect(await scratchCount()).toBe(0);
    } finally {
      releaseLock();
      await locker;
      await deleteRaceState(migrationName, rowId);
    }
  }, 180_000);

  it('quarantines a readable draft dump whose state differs from the frozen manifest', async () => {
    // Given a draft replaced by a later valid dump; When internal scratch equality runs;
    // Then no signed manifest, dump, receipt, or scratch database survives.
    const migrationName = `race_tamper_${suffix}`;
    const rowId = `race-tamper-${suffix}`;
    await expect(runBackup(options('tampered-draft'), {
      ...quietObserver,
      onDraftReady: async ({ dumpPath }) => {
        await insertRaceState(migrationName, rowId);
        const parsed = new URL(backupSourceUrl);
        execFileSync('pg_dump', [
          '--host', parsed.hostname, '--port', parsed.port, '--username', decodeURIComponent(parsed.username),
          '--dbname', decodeURIComponent(parsed.pathname.slice(1)), '--format', 'custom', '--file', dumpPath,
        ], { env: { ...process.env, PGPASSWORD: decodeURIComponent(parsed.password) }, stdio: 'pipe' });
      },
    })).rejects.toThrow(/BLRO_PRE_RECOVERY_EQUALITY_FAILED/u);
    expect(() => readFileSync(join(backupDir, 'tampered-draft.dump'))).toThrow();
    expect(() => readFileSync(join(backupDir, 'tampered-draft.manifest.json'))).toThrow();
    expect(await scratchCount()).toBe(0);
    await deleteRaceState(migrationName, rowId);
  }, 180_000);
});
