#!/usr/bin/env node
// BLRO authoritative backup.
//
//   node scripts/blro-backup.mjs --out <dir> --signing-key <ed25519.pem> [--apply]
//
// Dry-run is the default: it captures and verifies everything, then reports what *would* be
// published without writing a dump. `--apply` is the only mutating path.
//
// A backup becomes publishable only after the dump is read back from scratch and every captured
// digest is reproduced from the readback. Anything else is quarantined, never named valid.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { PrismaClient } from '@prisma/client';
import {
  captureAuditHeads, captureAuthorityState, captureEpochs, captureEvidenceObjects,
  captureRelationships, captureSchemaState, captureServerState, captureTableDigests, captureTableNames,
} from './lib/blro-backup-capture.mjs';
import {
  assertNoSecretMaterial, BACKUP_MANIFEST_VERSION, BlroBackupManifestError, canonicalJson, signManifest,
} from './lib/blro-backup-manifest.mjs';
import {
  assertBackupVerificationTarget, BlroRuntimeError, connectionUrl, listDumpTables, parseConnection,
  parseFlags, redactTarget, runPgTool,
} from './lib/blro-backup-runtime.mjs';
import { assertProductionRpoContract, evaluateSyncDurability } from './lib/blro-durability-contract.mjs';
import { resolveEvidenceObject } from './lib/blro-evidence-objects.mjs';
import { verifyPreRecoveryState } from './lib/blro-restore-verify.mjs';
import { withScratchRestore } from './lib/blro-scratch-restore.mjs';

const VALUE_FLAGS = ['--out', '--signing-key', '--mode', '--evidence-root', '--backup-id', '--verification-scratch-target'];
const BOOLEAN_FLAGS = ['--apply'];

export function parseBackupCli(argv) {
  const { values, flags } = parseFlags(argv, VALUE_FLAGS, BOOLEAN_FLAGS);
  const out = values.get('--out');
  const signingKeyPath = values.get('--signing-key');
  if (out === undefined) throw new BlroRuntimeError('BLRO_BACKUP_OUT_REQUIRED');
  if (signingKeyPath === undefined) throw new BlroRuntimeError('BLRO_BACKUP_SIGNING_KEY_REQUIRED');
  const mode = values.get('--mode') ?? 'task';
  if (mode !== 'task' && mode !== 'production') throw new BlroRuntimeError('BLRO_BACKUP_MODE_REFUSED', mode);
  const apply = flags.has('--apply');
  const verificationScratchTarget = values.get('--verification-scratch-target');
  if (apply && verificationScratchTarget === undefined) {
    throw new BlroRuntimeError('BLRO_BACKUP_VERIFICATION_TARGET_REQUIRED');
  }
  return {
    out,
    signingKeyPath,
    mode,
    evidenceRoot: values.get('--evidence-root') ?? 'data/evidence',
    backupId: values.get('--backup-id') ?? `blro-backup-${new Date().toISOString().replaceAll(/[:.]/gu, '-')}`,
    verificationScratchTarget,
    apply,
  };
}

/** Capture everything the manifest describes, from the live authoritative database. */
export async function captureAuthoritativeState(sql, options) {
  const server = await captureServerState(sql);
  const tables = await captureTableNames(sql);
  const rpo = assertProductionRpoContract(
    evaluateSyncDurability(server.settings, server.syncReplicaCount),
    options.mode,
  );
  return {
    postgres: server.postgres,
    schema: await captureSchemaState(sql, tables),
    tables: await captureTableDigests(sql, tables),
    relationships: await captureRelationships(sql, tables),
    epochs: await captureEpochs(sql),
    auditHeads: await captureAuditHeads(sql),
    authority: await captureAuthorityState(sql),
    evidenceObjects: await captureEvidenceObjects(sql, (manifest) => resolveEvidenceObject(manifest, options.evidenceRoot)),
    rpo,
  };
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Internal verification: read the dump back with pg_restore's own reader in a scratch directory.
 * A dump whose table of contents cannot be listed, or whose data members do not cover every
 * captured table, is not a backup.
 */
export function verifyDumpReadback(dumpPath, expectedTables) {
  const dumped = listDumpTables(dumpPath);
  const missing = expectedTables.filter((table) => !dumped.has(table));
  if (missing.length > 0) throw new BlroBackupManifestError('BLRO_BACKUP_DUMP_TABLE_MISSING', missing.join(', '));
  return dumped.size;
}

async function exportBackupSnapshot(sql) {
  await sql.$executeRawUnsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY DEFERRABLE');
  const [session] = await sql.$queryRawUnsafe(`SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS "readOnly", current_setting('transaction_deferrable') AS deferrable, r.rolbypassrls AS "bypassRls", r.rolsuper AS superuser, r.rolcreatedb AS "createDb", r.rolcreaterole AS "createRole", has_schema_privilege(current_user,current_schema(),'CREATE') AS "schemaCreate", EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relkind='r' AND (has_table_privilege(current_user,c.oid,'INSERT') OR has_table_privilege(current_user,c.oid,'UPDATE') OR has_table_privilege(current_user,c.oid,'DELETE') OR has_table_privilege(current_user,c.oid,'TRUNCATE') OR has_table_privilege(current_user,c.oid,'TRIGGER'))) AS "tableWrite" FROM pg_roles r WHERE r.rolname=current_user`);
  const valid = session?.isolation === 'repeatable read' && session.readOnly === 'on'
    && session.deferrable === 'on' && session.bypassRls === true && session.superuser === false
    && session.createDb === false && session.createRole === false
    && session.schemaCreate === false && session.tableWrite === false;
  if (!valid) throw new BlroRuntimeError('BLRO_BACKUP_READ_ONLY_ROLE_REQUIRED');
  const [snapshot] = await sql.$queryRawUnsafe('SELECT pg_export_snapshot() AS id');
  if (typeof snapshot?.id !== 'string' || snapshot.id.length === 0) {
    throw new BlroRuntimeError('BLRO_BACKUP_SNAPSHOT_EXPORT_FAILED');
  }
  return snapshot.id;
}

/** Capture state and custom dump from one exported snapshot, held until both complete. */
export async function captureSnapshotDraft(options) {
  return options.sql.$transaction(async (tx) => {
    const snapshotId = await exportBackupSnapshot(tx);
    await options.onSnapshotExported?.();
    const captured = await captureAuthoritativeState(tx, options.captureOptions);
    if (options.dumpPath !== undefined) {
      runPgTool('pg_dump', options.connection, [
        '--dbname', options.connection.database, '--format', 'custom',
        `--snapshot=${snapshotId}`, '--file', options.dumpPath,
      ]);
    }
    return captured;
  }, { maxWait: 10_000, timeout: 600_000 });
}

export async function runBackup(options, observer = {}) {
  const writeOutput = observer.writeOutput ?? ((text) => process.stdout.write(text));
  const writeError = observer.writeError ?? ((text) => process.stderr.write(text));
  const databaseUrl = process.env['BLRO_BACKUP_DATABASE_URL']?.trim();
  if (!databaseUrl) throw new BlroRuntimeError('BLRO_BACKUP_DATABASE_URL_REQUIRED');
  const connection = parseConnection(databaseUrl, 'BLRO_BACKUP_DATABASE_URL');
  const sql = new PrismaClient({ datasources: { db: { url: connectionUrl(connection) } } });
  const quarantine = mkdtempSync(join(tmpdir(), 'blro-backup-quarantine-'));
  const stagedDump = options.apply ? join(quarantine, `${options.backupId}.dump`) : undefined;
  let published = false;
  let publishedDump;
  let publishedManifest;
  let dumpMoved = false;
  let manifestMoved = false;
  try {
    const captured = await captureSnapshotDraft({
      sql,
      connection,
      dumpPath: stagedDump,
      captureOptions: options,
      onSnapshotExported: observer.onSnapshotExported,
    });
    const tableNames = captured.tables.map((table) => table.table);
    if (!options.apply) {
      writeOutput(`${canonicalJson({
        dryRun: true,
        source: redactTarget(connection),
        backupId: options.backupId,
        tables: tableNames.length,
        relationships: captured.relationships.length,
        evidenceObjects: captured.evidenceObjects.length,
        rpo: captured.rpo,
      })}\nBLRO_BACKUP_DRY_RUN\n`);
      return;
    }
    if (stagedDump === undefined || options.verificationScratchTarget === undefined) {
      throw new BlroRuntimeError('BLRO_BACKUP_VERIFICATION_TARGET_REQUIRED');
    }
    const adminUrl = process.env['BLRO_SCRATCH_ADMIN_DATABASE_URL']?.trim();
    if (!adminUrl) throw new BlroRuntimeError('BLRO_SCRATCH_ADMIN_DATABASE_URL_REQUIRED');
    const admin = parseConnection(adminUrl, 'BLRO_SCRATCH_ADMIN_DATABASE_URL');
    const target = assertBackupVerificationTarget(
      parseConnection(options.verificationScratchTarget, '--verification-scratch-target'),
      connection,
      admin,
    );
    verifyDumpReadback(stagedDump, tableNames);
    const draft = {
      version: BACKUP_MANIFEST_VERSION,
      backupId: options.backupId,
      mode: options.mode,
      capturedAt: new Date().toISOString(),
      dump: {
        format: 'custom',
        fileName: `${options.backupId}.dump`,
        bytes: statSync(stagedDump).size,
        sha256: sha256File(stagedDump),
      },
      ...captured,
    };
    await observer.onDraftReady?.({ dumpPath: stagedDump });
    await withScratchRestore({ admin, target, dumpPath: stagedDump }, async (scratch) => {
      await verifyPreRecoveryState(scratch, draft, options.evidenceRoot);
    });
    const manifest = signManifest(draft, options.signingKeyPath);
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    assertNoSecretMaterial(manifestText, 'published manifest');
    const stagedManifest = join(quarantine, `${options.backupId}.manifest.json`);
    writeFileSync(stagedManifest, manifestText);
    mkdirSync(options.out, { recursive: true });
    publishedDump = join(options.out, manifest.dump.fileName);
    publishedManifest = join(options.out, `${options.backupId}.manifest.json`);
    if (existsSync(publishedDump) || existsSync(publishedManifest)) {
      throw new BlroRuntimeError('BLRO_BACKUP_PUBLICATION_EXISTS', options.backupId);
    }
    renameSync(stagedDump, publishedDump);
    dumpMoved = true;
    renameSync(stagedManifest, publishedManifest);
    manifestMoved = true;
    published = true;
    writeOutput(`${canonicalJson({
      backupId: manifest.backupId,
      source: redactTarget(connection),
      tables: manifest.tables.length,
      dumpSha256: manifest.dump.sha256,
      recoveryPoint: manifest.postgres.recoveryPoint,
      rpo: manifest.rpo,
    })}\nBLRO_BACKUP_PUBLISHED\n`);
  } finally {
    try {
      await sql.$disconnect();
    } finally {
      if (options.apply && !published) {
        if (dumpMoved && publishedDump !== undefined) rmSync(publishedDump, { force: true });
        if (manifestMoved && publishedManifest !== undefined) rmSync(publishedManifest, { force: true });
        writeError('BLRO_BACKUP_QUARANTINED\n');
      }
      rmSync(quarantine, { recursive: true, force: true });
    }
  }
}

if (process.argv[1]?.endsWith('blro-backup.mjs')) {
  runBackup(parseBackupCli(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
