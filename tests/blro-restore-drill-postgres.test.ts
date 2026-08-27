// Real-PostgreSQL restore drill: back up a live authority database, restore it into a disposable
// scratch database, and prove the whole contract end to end.
//
// Nothing here is mocked. The dump is produced by pg_dump, restored by pg_restore, and every
// assertion reads the resulting catalog. The source database is snapshotted before the drill and
// re-read after it, so "the drill did not touch production" is a measurement, not a promise.
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalJson, parseManifest, verifyManifestSignature } from '../scripts/lib/blro-backup-manifest.mjs';
import { dropDrillFixture, seedDrillFixture } from '../scripts/lib/blro-drill-fixture.mjs';
import { drillReceiptSchema, DRILL_PASS_SENTINEL } from '../scripts/lib/blro-drill-receipt.mjs';

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
const auditSecret = 'drill-audit-secret-'.padEnd(48, 'x');
const scratchDatabase = `blro_scratch_${suffix}`;
const verificationDatabase = `blro_scratch_backup_verify_${suffix}`;

let root = '';
let evidenceRoot = '';
let backupDir = '';
let privateKeyPath = '';
let publicKeyPath = '';
let owner: PrismaClient;
let fixture: Awaited<ReturnType<typeof seedDrillFixture>>;

type SourceSnapshot = {
  readonly epoch: number;
  readonly revision: number;
  readonly approvalStatuses: readonly string[];
  readonly unconsumedNonces: number;
  readonly auditCount: number;
  readonly auditHead: string;
  readonly jobStates: readonly string[];
  readonly tableDigest: string;
};

/**
 * Everything about the source a restore drill must be unable to change.
 *
 * The whole snapshot runs inside ONE transaction with a transaction-local scope. Prisma pools
 * connections, so a session-level `set_config` can land on a different backend than the following
 * query, and every RLS-scoped table then reads back empty — a silent false "unchanged".
 */
async function snapshotSource(): Promise<SourceSnapshot> {
  return owner.$transaction(async (tx) => {
    const rows = async <T>(statement: string, ...values: readonly unknown[]): Promise<T[]> =>
      tx.$queryRawUnsafe<T[]>(statement, ...values);
    await tx.$executeRawUnsafe(`SELECT set_config('app.project_id',$1,true)`, fixture.projectId);
    const [epoch] = await rows<{ epoch: number; revision: number }>(
      `SELECT "epoch","revision" FROM "BlroProjectAuthorityEpoch" WHERE "projectId"=$1`, fixture.projectId);
    const approvals = await rows<{ status: string }>(
      `SELECT "status" FROM "BlroApproval" WHERE "projectId"=$1 ORDER BY "id"`, fixture.projectId);
    const [nonces] = await rows<{ count: number }>(
      `SELECT count(*)::int AS count FROM "BlroApprovalNonce" WHERE "projectId"=$1 AND "consumedAt" IS NULL`, fixture.projectId);
    const audit = await rows<{ hash: string }>(
      `SELECT "hash" FROM "BlroAuditEvent" WHERE "projectId"=$1 ORDER BY "seq"`, fixture.projectId);
    const jobs = await rows<{ state: string }>(
      `SELECT "state" FROM "BlroRemoteJob" WHERE "projectId"=$1 ORDER BY "id"`, fixture.projectId);
    const [digest] = await rows<{ combined: string }>(
      `SELECT coalesce(md5(string_agg(d,'')),'') AS combined FROM (SELECT md5(t.*::text) AS d FROM "BlroRemoteJob" t WHERE "projectId"=$1 ORDER BY 1) o`, fixture.projectId);
    // A vacuous snapshot proves nothing: the fixture always has these rows.
    if (audit.length === 0 || jobs.length === 0 || epoch === undefined) {
      throw new Error('BLRO_DRILL_SOURCE_SNAPSHOT_VACUOUS');
    }
    return {
      epoch: epoch.epoch,
      revision: epoch.revision,
      approvalStatuses: approvals.map((row) => row.status),
      unconsumedNonces: nonces?.count ?? -1,
      auditCount: audit.length,
      auditHead: audit[audit.length - 1]?.hash ?? '',
      jobStates: jobs.map((row) => row.state),
      tableDigest: digest?.combined ?? '',
    };
  }, { isolationLevel: 'Serializable', maxWait: 10_000, timeout: 60_000 });
}

/**
 * Run one CLI as a child process. Its stderr is captured rather than inherited: these tests
 * deliberately trigger refusals, and letting those messages reach the parent's stderr corrupts the
 * mandatory profile's JSON report, which concatenates both streams.
 */
function runCli(script: string, args: readonly string[], overrides: NodeJS.ProcessEnv = {}): string {
  return execFileSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      BLRO_BACKUP_DATABASE_URL: backupUrl,
      BLRO_SCRATCH_ADMIN_DATABASE_URL: adminUrl,
      SANGFOR_BLRO_AUDIT_SECRET: auditSecret,
      ...overrides,
    },
  });
}

const backupArgs = (id: string): readonly string[] => [
  '--out', backupDir, '--signing-key', privateKeyPath, '--evidence-root', evidenceRoot, '--backup-id', id,
  '--verification-scratch-target', `${adminUrl?.replace(/\/[^/]*$/u, '')}/${verificationDatabase}`,
];

const drillArgs = (id: string, database = scratchDatabase, verifyKey = publicKeyPath): readonly string[] => [
  '--backup-dir', backupDir, '--backup-id', id, '--public-key', verifyKey,
  '--signing-key', privateKeyPath, '--evidence-root', evidenceRoot,
  '--scratch-target', `${adminUrl?.replace(/\/[^/]*$/u, '')}/${database}`,
];

function scratchDatabaseCount(database: string): number {
  const [row] = JSON.parse(execFileSync(process.execPath, ['-e', `
    const { PrismaClient } = require('@prisma/client');
    const sql = new PrismaClient({ datasources: { db: { url: ${JSON.stringify(adminUrl)} } } });
    sql.$queryRawUnsafe('SELECT count(*)::int AS count FROM pg_database WHERE datname = $1', ${JSON.stringify(database)})
      .then((rows) => { process.stdout.write(JSON.stringify(rows)); return sql.$disconnect(); });
  `], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) as Array<{ count: number }>;
  return row?.count ?? -1;
}

/**
 * A drill fixture left behind by an interrupted earlier run references an evidence object under
 * that run's temp root, which no longer exists — so the backup correctly refuses and every later
 * run fails for a reason that has nothing to do with the code under test. Name that condition
 * explicitly instead of letting it surface as an opaque backup failure.
 */
async function assertNoForeignDrillResidue(sql: PrismaClient): Promise<void> {
  const rows = await sql.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT "id" FROM "BlroProject" WHERE "id" LIKE 'drill-project-%' AND "id" <> $1`,
    `drill-project-${suffix}`,
  );
  if (rows.length > 0) {
    throw new Error(`BLRO_DRILL_FOREIGN_FIXTURE_RESIDUE: ${rows.map((row) => row.id).join(', ')}`);
  }
}

function runAdminSql(statement: string): void {
  execFileSync(process.execPath, ['-e', `
    const { PrismaClient } = require('@prisma/client');
    const sql = new PrismaClient({ datasources: { db: { url: ${JSON.stringify(adminUrl)} } } });
    sql.$executeRawUnsafe(${JSON.stringify(statement)}).then(() => sql.$disconnect());
  `], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

describeDatabase('BLRO restore drill against real PostgreSQL', () => {
  let before: SourceSnapshot;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'blro-drill-it-'));
    evidenceRoot = join(root, 'evidence');
    backupDir = join(root, 'backups');
    mkdirSync(evidenceRoot, { recursive: true });
    mkdirSync(backupDir, { recursive: true });
    const pair = generateKeyPairSync('ed25519');
    privateKeyPath = join(root, 'task.pem');
    publicKeyPath = join(root, 'task.pub.pem');
    writeFileSync(privateKeyPath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), { mode: 0o600 });
    writeFileSync(publicKeyPath, pair.publicKey.export({ type: 'spki', format: 'pem' }).toString());
    owner = new PrismaClient({ datasources: { db: { url: ownerUrl } } });
    await assertNoForeignDrillResidue(owner);
    fixture = await seedDrillFixture(owner, { suffix, auditSecret, evidenceRoot });
    before = await snapshotSource();
    runCli('scripts/blro-backup.mjs', [...backupArgs('drill'), '--apply']);
  }, 180_000);

  afterAll(async () => {
    // Teardown must survive a half-completed setup: a fixture left behind in the shared task
    // database poisons every later run, because its evidence object lives under this run's temp
    // root and becomes unresolvable the moment the root is removed.
    try {
      if (fixture) await dropDrillFixture(owner, fixture);
    } finally {
      await owner?.$disconnect();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('publishes a signed manifest that captures the live authority state', () => {
    // Given a live authority database; When backed up; Then the manifest is signed and complete.
    const manifest = verifyManifestSignature(
      parseManifest(readFileSync(join(backupDir, 'drill.manifest.json'), 'utf8')),
      publicKeyPath,
    );
    expect(manifest.tables.length).toBe(60);
    expect(manifest.relationships.length).toBe(125);
    expect(manifest.epochs.find((epoch) => epoch.projectId === fixture.projectId)?.epoch).toBe(fixture.epoch);
    expect(manifest.auditHeads.find((head) => head.projectId === fixture.projectId))
      .toMatchObject({ eventCount: 3, headSeq: 2, headHash: fixture.auditHeadHash, keyedCount: 3 });
    expect(manifest.authority.outstandingApprovals.map((approval) => approval.id)).toContain(fixture.approvalId);
    expect(manifest.authority.outstandingNonces.map((nonce) => nonce.id)).toContain(fixture.nonceId);
    expect(manifest.authority.indeterminateCount).toBeGreaterThanOrEqual(1);
    expect(manifest.evidenceObjects.find((object) => object.id === fixture.evidenceId))
      .toMatchObject({ objectPath: fixture.evidenceObjectPath, objectHash: fixture.evidenceObjectHash });
  });

  it('never writes a credential into the published manifest', () => {
    // Given a manifest produced from a credentialed URL; Then no password appears in its bytes.
    const text = readFileSync(join(backupDir, 'drill.manifest.json'), 'utf8');
    expect(text).not.toContain('blro_backup_local');
    expect(text).not.toContain('PRIVATE KEY');
  });

  it('completes the drill, spends outstanding authority and preserves uncertainty', () => {
    // Given a verified backup; When drilled into a fresh scratch DB; Then the sentinel is printed.
    const output = runCli('scripts/blro-restore-drill.mjs', [
      ...drillArgs('drill'), '--receipt-out', join(root, 'receipt.json'),
    ]);
    expect(output.trimEnd().endsWith(DRILL_PASS_SENTINEL)).toBe(true);

    const receipt = drillReceiptSchema.parse(JSON.parse(readFileSync(join(root, 'receipt.json'), 'utf8')));
    verifyManifestSignature(receipt, publicKeyPath);
    expect(receipt.verified.equalityProblems).toBe(0);
    expect(receipt.verified.tables).toBe(60);
    expect(receipt.verified.relationships).toBe(125);
    expect(receipt.verified.evidenceObjects).toBeGreaterThanOrEqual(1);
    expect(receipt.drill.withinBudget).toBe(true);
    expect(receipt.drill.rtoMs).toBeLessThanOrEqual(receipt.drill.rtoBudgetMs);

    const policy = receipt.policy.find((entry) => entry.projectId === fixture.projectId);
    expect(policy).toMatchObject({ epoch: fixture.epoch + 1, spentApprovals: 1, spentNonces: 1 });
    expect(receipt.preserved.indeterminate).toBeGreaterThanOrEqual(1);

    const refusals = receipt.replayRefusals.find((entry) => entry.projectId === fixture.projectId)?.refusals ?? [];
    expect(refusals.map((refusal) => refusal.reason)).toEqual(
      expect.arrayContaining(['AUTHORITY_EPOCH_STALE', 'APPROVAL_ALREADY_SPENT', 'NONCE_ALREADY_USED']),
    );
  }, 300_000);

  it('drops exactly the scratch databases it created', () => {
    // Given completed publication and drill verification; Then neither owned scratch DB survives.
    expect(scratchDatabaseCount(verificationDatabase)).toBe(0);
    expect(scratchDatabaseCount(scratchDatabase)).toBe(0);
  });

  it('leaves the source database byte-identical', async () => {
    // Given the pre-drill snapshot; When re-read after the drill; Then every field is unchanged.
    expect(await snapshotSource()).toEqual(before);
  });

  it('refuses a second drill onto a target that already exists', () => {
    // Given a scratch database that already exists; When drilled; Then it refuses as dirty.
    const occupied = `blro_scratch_${suffix}_occupied`;
    runAdminSql(`CREATE DATABASE "${occupied}"`);
    try {
      expect(() => runCli('scripts/blro-restore-drill.mjs', drillArgs('drill', occupied)))
        .toThrowError(/BLRO_DRILL_TARGET_EXISTS_DIRTY/u);
    } finally {
      runAdminSql(`DROP DATABASE IF EXISTS "${occupied}" WITH (FORCE)`);
    }
  }, 120_000);

  it('refuses to restore onto the source database', () => {
    // Given the source as the target; When drilled; Then the scratch contract refuses.
    expect(() => runCli('scripts/blro-restore-drill.mjs', [
      '--backup-dir', backupDir, '--backup-id', 'drill', '--public-key', publicKeyPath,
      '--signing-key', privateKeyPath, '--evidence-root', evidenceRoot,
      '--scratch-target', backupUrl ?? '',
    ])).toThrowError(/BLRO_DRILL_TARGET_NOT_SCRATCH/u);
  });

  it('halts before creating anything when the dump is corrupt', () => {
    // Given a dump whose bytes were flipped; When drilled; Then it refuses and creates no database.
    const target = `blro_scratch_${suffix}_corrupt`;
    const dumpPath = join(backupDir, 'corrupt.dump');
    const manifestPath = join(backupDir, 'corrupt.manifest.json');
    const original = readFileSync(join(backupDir, 'drill.dump'));
    const flipped = Buffer.from(original);
    flipped[Math.floor(flipped.byteLength / 2)] ^= 0xff;
    writeFileSync(dumpPath, flipped);
    const manifest = JSON.parse(readFileSync(join(backupDir, 'drill.manifest.json'), 'utf8')) as Record<string, unknown>;
    writeFileSync(manifestPath, JSON.stringify({
      ...manifest, dump: { ...(manifest['dump'] as Record<string, unknown>), fileName: 'corrupt.dump' },
    }, null, 2));
    expect(() => runCli('scripts/blro-restore-drill.mjs', drillArgs('corrupt', target)))
      .toThrowError(/BLRO_BACKUP_MANIFEST_PAYLOAD_DIGEST_MISMATCH|BLRO_DRILL_DUMP_HASH_MISMATCH/u);
    expect(scratchDatabaseCount(target)).toBe(0);
  }, 120_000);

  it('halts before creating anything when the evidence object is gone', () => {
    // Given a referenced evidence object deleted after backup; When drilled; Then it halts.
    const target = `blro_scratch_${suffix}_noevidence`;
    const objectPath = join(evidenceRoot, fixture.evidenceObjectPath);
    const preserved = readFileSync(objectPath);
    rmSync(objectPath);
    try {
      expect(() => runCli('scripts/blro-restore-drill.mjs', drillArgs('drill', target)))
        .toThrowError(/BLRO_EVIDENCE_OBJECT_UNRESOLVABLE|BLRO_DRILL_EVIDENCE_OBJECT/u);
      expect(scratchDatabaseCount(target)).toBe(0);
    } finally {
      writeFileSync(objectPath, preserved);
    }
  }, 120_000);

  it('halts when the evidence object bytes changed after backup', () => {
    // Given a rewritten evidence object; When drilled; Then the exact-hash gate halts the drill.
    const target = `blro_scratch_${suffix}_hashloss`;
    const objectPath = join(evidenceRoot, fixture.evidenceObjectPath);
    const preserved = readFileSync(objectPath);
    writeFileSync(objectPath, Buffer.concat([preserved, Buffer.from('!')]));
    try {
      expect(() => runCli('scripts/blro-restore-drill.mjs', drillArgs('drill', target)))
        .toThrowError(/BLRO_DRILL_EVIDENCE_OBJECT_(HASH|SIZE)_MISMATCH/u);
      expect(scratchDatabaseCount(target)).toBe(0);
    } finally {
      writeFileSync(objectPath, preserved);
    }
  }, 120_000);

  it('halts when the manifest signature does not match the drill public key', () => {
    // Given a foreign public key; When drilled; Then the signature gate halts before restore.
    const target = `blro_scratch_${suffix}_wrongkey`;
    const foreign = join(root, 'foreign.pub.pem');
    writeFileSync(foreign, generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString());
    expect(() => runCli('scripts/blro-restore-drill.mjs', drillArgs('drill', target, foreign)))
      .toThrowError(/BLRO_BACKUP_MANIFEST_KEY_MISMATCH/u);
    expect(scratchDatabaseCount(target)).toBe(0);
  }, 120_000);

  it('quarantines an interrupted dump rather than publishing it', () => {
    // Given a backup that cannot reach its output; When applied; Then nothing is named valid.
    const blocked = join(root, 'blocked-output');
    writeFileSync(blocked, 'not a directory');
    expect(() => runCli('scripts/blro-backup.mjs', [
      '--out', blocked, '--signing-key', privateKeyPath, '--evidence-root', evidenceRoot,
      '--backup-id', 'interrupted', '--verification-scratch-target',
      `${adminUrl?.replace(/\/[^/]*$/u, '')}/${verificationDatabase}`, '--apply',
    ])).toThrowError();
    expect(existsSync(join(blocked, 'interrupted.dump'))).toBe(false);
    expect(existsSync(join(backupDir, 'interrupted.manifest.json'))).toBe(false);
  }, 180_000);

  it('reports the dry run without producing a dump', () => {
    // Given no --apply; When run; Then it reports intent and writes nothing.
    const output = runCli('scripts/blro-backup.mjs', backupArgs('dryrun'));
    expect(output).toContain('BLRO_BACKUP_DRY_RUN');
    expect(existsSync(join(backupDir, 'dryrun.dump'))).toBe(false);
    expect(existsSync(join(backupDir, 'dryrun.manifest.json'))).toBe(false);
  }, 120_000);

  it('records honest RPO findings rather than claiming RPO0 from the dump', () => {
    // Given a single-node task cluster; Then the manifest states the dump-only RPO plainly.
    const manifest = parseManifest(readFileSync(join(backupDir, 'drill.manifest.json'), 'utf8'));
    expect(manifest.rpo.syncDurabilityProven).toBe(false);
    expect(manifest.rpo.claim).toMatch(/It is NOT zero/u);
    expect(manifest.rpo.findings.length).toBeGreaterThan(0);
    expect(canonicalJson(manifest.rpo)).not.toMatch(/RPO=0 for committed/u);
  });
});
