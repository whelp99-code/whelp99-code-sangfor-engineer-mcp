// Pre-restore gates and post-restore equality proof for the BLRO restore drill.
//
// Every gate here runs BEFORE any database is created: a drill that discovers a bad manifest after
// it has already restored has proven nothing except that it wastes an hour. After the restore, the
// captured state is re-derived from the scratch target with the same code the backup used, and
// compared field by field — 100% of tables, relationships, chains and evidence hashes.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import {
  captureAuditHeads, captureAuthorityState, captureEpochs, captureEvidenceObjects,
  captureRelationships, captureSchemaState, captureTableDigests, captureTableNames,
} from './blro-backup-capture.mjs';
import { canonicalJson, parseManifest, verifyManifestSignature } from './blro-backup-manifest.mjs';
import { BlroRuntimeError, listDumpTables } from './blro-backup-runtime.mjs';
import { resolveEvidenceObject } from './blro-evidence-objects.mjs';

export class BlroRestoreVerifyError extends Error {
  constructor(code, detail) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'BlroRestoreVerifyError';
    this.code = code;
  }
}

/**
 * Gate 1-4, in order and all before any DDL:
 * manifest signature, dump bytes, dump readability, evidence-object existence and hash.
 */
export function verifyBackupBeforeRestore(paths) {
  if (!existsSync(paths.manifestPath)) throw new BlroRestoreVerifyError('BLRO_DRILL_MANIFEST_MISSING');
  if (!existsSync(paths.dumpPath)) throw new BlroRestoreVerifyError('BLRO_DRILL_DUMP_MISSING');
  const manifest = verifyManifestSignature(
    parseManifest(readFileSync(paths.manifestPath, 'utf8')),
    paths.publicKeyPath,
  );
  const bytes = readFileSync(paths.dumpPath);
  if (bytes.byteLength !== manifest.dump.bytes) {
    throw new BlroRestoreVerifyError('BLRO_DRILL_DUMP_TRUNCATED', `${bytes.byteLength} != ${manifest.dump.bytes}`);
  }
  if (createHash('sha256').update(bytes).digest('hex') !== manifest.dump.sha256) {
    throw new BlroRestoreVerifyError('BLRO_DRILL_DUMP_HASH_MISMATCH');
  }
  let dumped;
  try {
    dumped = listDumpTables(paths.dumpPath);
  } catch (error) {
    if (error instanceof BlroRuntimeError) throw new BlroRestoreVerifyError('BLRO_DRILL_DUMP_UNREADABLE', error.code);
    throw error;
  }
  const missing = manifest.tables.filter((table) => !dumped.has(table.table)).map((table) => table.table);
  if (missing.length > 0) throw new BlroRestoreVerifyError('BLRO_DRILL_DUMP_TABLE_MISSING', missing.join(', '));
  verifyEvidenceObjects(manifest, paths.evidenceRoot);
  return manifest;
}

/** Every referenced evidence object must exist with the exact hash the manifest recorded. */
export function verifyEvidenceObjects(manifest, evidenceRoot) {
  for (const object of manifest.evidenceObjects) {
    if (object.objectPath.startsWith('inline:')) continue;
    const resolved = resolveEvidenceObject(
      { id: object.id, contentHash: object.contentHash, manifest: { objects: object.objectPath.split('|').map((objectPath) => ({ objectPath })) } },
      evidenceRoot,
    );
    if (resolved.objectHash !== object.objectHash) {
      throw new BlroRestoreVerifyError('BLRO_DRILL_EVIDENCE_OBJECT_HASH_MISMATCH', object.id);
    }
    if (resolved.objectBytes !== object.objectBytes) {
      throw new BlroRestoreVerifyError('BLRO_DRILL_EVIDENCE_OBJECT_SIZE_MISMATCH', object.id);
    }
  }
  return manifest.evidenceObjects.length;
}

/**
 * Schema compatibility, before restore. A dump whose migration set is not exactly the working
 * tree's set is refused — stale in either direction, since a newer dump restored onto older code
 * is just as unrecoverable as the reverse.
 */
export function verifySchemaCompatibility(manifest, workingTreeMigrations) {
  const backup = manifest.schema.migrations.map((migration) => migration.name);
  const tree = [...workingTreeMigrations].sort();
  const missingInTree = backup.filter((name) => !tree.includes(name));
  const missingInBackup = tree.filter((name) => !backup.includes(name));
  if (missingInTree.length > 0) {
    throw new BlroRestoreVerifyError('BLRO_DRILL_SCHEMA_NEWER_THAN_TREE', missingInTree.join(', '));
  }
  if (missingInBackup.length > 0) {
    throw new BlroRestoreVerifyError('BLRO_DRILL_SCHEMA_STALE', missingInBackup.join(', '));
  }
  return backup.length;
}

/** Re-derive the manifest's machine-derived state from the restored scratch target. */
export async function recaptureState(sql, evidenceRoot) {
  const tables = await captureTableNames(sql);
  return {
    schema: await captureSchemaState(sql, tables),
    tables: await captureTableDigests(sql, tables),
    relationships: await captureRelationships(sql, tables),
    epochs: await captureEpochs(sql),
    auditHeads: await captureAuditHeads(sql),
    authority: await captureAuthorityState(sql),
    evidenceObjects: await captureEvidenceObjects(sql, (row) => resolveEvidenceObject(row, evidenceRoot)),
  };
}

function compare(problems, label, expected, actual) {
  if (canonicalJson(expected) !== canonicalJson(actual)) problems.push(label);
}

/**
 * Full equality proof against the manifest. Returns the problem list rather than throwing, so the
 * caller can report every difference at once instead of only the first.
 */
export function diffAgainstManifest(manifest, recaptured) {
  const problems = [];
  const expectedTables = new Map(manifest.tables.map((table) => [table.table, table]));
  const actualTables = new Map(recaptured.tables.map((table) => [table.table, table]));
  for (const [name, expected] of expectedTables) {
    const actual = actualTables.get(name);
    if (!actual) { problems.push(`table missing after restore: ${name}`); continue; }
    if (actual.rowCount !== expected.rowCount) problems.push(`row count ${name}: ${actual.rowCount} != ${expected.rowCount}`);
    if (actual.setDigest !== expected.setDigest) problems.push(`set digest ${name}`);
  }
  for (const name of actualTables.keys()) {
    if (!expectedTables.has(name)) problems.push(`extra table after restore: ${name}`);
  }
  compare(problems, 'relationship set', manifest.relationships, recaptured.relationships);
  compare(problems, 'authority epochs', manifest.epochs, recaptured.epochs);
  compare(problems, 'audit chain heads', manifest.auditHeads, recaptured.auditHeads);
  compare(problems, 'evidence objects', manifest.evidenceObjects, recaptured.evidenceObjects);
  compare(problems, 'schema migrations', manifest.schema.migrations, recaptured.schema.migrations);
  compare(problems, 'schema migration digest', manifest.schema.migrationDigest, recaptured.schema.migrationDigest);
  compare(problems, 'schema catalog digest', manifest.schema.catalogDigest, recaptured.schema.catalogDigest);
  compare(problems, 'schema table count', manifest.schema.tableCount, recaptured.schema.tableCount);
  compare(problems, 'remote job tombstones', manifest.authority.remoteJobs, recaptured.authority.remoteJobs);
  compare(problems, 'outstanding approvals', manifest.authority.outstandingApprovals, recaptured.authority.outstandingApprovals);
  compare(problems, 'outstanding nonces', manifest.authority.outstandingNonces, recaptured.authority.outstandingNonces);
  return problems;
}

/**
 * Prove every commit at or before the captured recovery point survived the restore.
 * The dump's snapshot is taken at that LSN, so the manifest's per-table digests ARE the set of
 * committed rows at that point: equality of all of them is the proof, and it is asserted here
 * rather than assumed from the fact that pg_restore exited zero.
 */
export function assertRecoveryPointCommitsPresent(manifest, recaptured) {
  const expected = manifest.tables.reduce((total, table) => total + table.rowCount, 0);
  const actual = recaptured.tables.reduce((total, table) => total + table.rowCount, 0);
  if (expected !== actual) {
    throw new BlroRestoreVerifyError('BLRO_DRILL_RECOVERY_POINT_COMMITS_LOST', `${actual} != ${expected}`);
  }
  return { recoveryPoint: manifest.postgres.recoveryPoint, committedRows: expected };
}

/** Shared PRE-recovery verification. This function reads only and never applies recovery policy. */
export async function verifyPreRecoveryState(sql, manifest, evidenceRoot) {
  const recaptured = await recaptureState(sql, evidenceRoot);
  const problems = diffAgainstManifest(manifest, recaptured);
  if (problems.length > 0) {
    throw new BlroRestoreVerifyError('BLRO_PRE_RECOVERY_EQUALITY_FAILED', problems.join('; '));
  }
  return {
    recaptured,
    recovery: assertRecoveryPointCommitsPresent(manifest, recaptured),
    equalityProblems: problems.length,
  };
}
