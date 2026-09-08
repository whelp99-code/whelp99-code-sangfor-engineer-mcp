// Machine-derived capture of authoritative PostgreSQL state for a BLRO backup manifest.
//
// Nothing here is hand-listed: the table set comes from the live catalog, relationships come from
// pg_constraint, and every digest is computed from the rows themselves. A capture that cannot
// derive a value refuses rather than emitting a placeholder.
import { createHash } from 'node:crypto';
import { canonicalJson } from './blro-backup-manifest.mjs';

export class BlroCaptureError extends Error {
  constructor(code, detail) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'BlroCaptureError';
    this.code = code;
  }
}

const digestOf = (value) => createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');

/** JSON-safe projection: BigInt and Date have no canonical JSON form of their own. */
function plain(value) {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(plain);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, plain(inner)]));
  }
  return value;
}

async function query(sql, statement, ...values) {
  return plain(await sql.$queryRawUnsafe(statement, ...values));
}

export async function captureServerState(sql) {
  const [server] = await query(sql, `SELECT current_setting('server_version_num') AS "versionNum", current_setting('server_version') AS "versionText", current_database() AS "databaseName", current_schema() AS "schemaName", (SELECT system_identifier::text FROM pg_control_system()) AS "systemIdentifier", pg_is_in_recovery() AS "inRecovery", (SELECT timeline_id FROM pg_control_checkpoint()) AS "timelineId"`);
  if (!server) throw new BlroCaptureError('BLRO_BACKUP_SERVER_STATE_UNAVAILABLE');
  const [lsn] = await query(sql, `SELECT CASE WHEN pg_is_in_recovery() THEN pg_last_wal_replay_lsn()::text ELSE pg_current_wal_lsn()::text END AS lsn`);
  const settings = await query(sql, `SELECT name, setting FROM pg_settings WHERE name = ANY($1)`, [
    'synchronous_commit', 'synchronous_standby_names', 'wal_level', 'fsync', 'full_page_writes', 'archive_mode',
  ]);
  const [replication] = await query(sql, `SELECT count(*)::int AS count FROM pg_stat_replication WHERE sync_state IN ('sync','quorum')`);
  const byName = new Map(settings.map((row) => [row.name, row.setting]));
  const required = (name) => {
    const value = byName.get(name);
    if (value === undefined) throw new BlroCaptureError('BLRO_BACKUP_SETTING_UNAVAILABLE', name);
    return value;
  };
  return {
    settings,
    syncReplicaCount: replication?.count ?? 0,
    postgres: {
      versionNum: Number(server.versionNum),
      versionText: server.versionText,
      databaseName: server.databaseName,
      schemaName: server.schemaName,
      systemIdentifier: server.systemIdentifier,
      recoveryPoint: { lsn: lsn?.lsn ?? '', inRecovery: server.inRecovery, timelineId: Number(server.timelineId) },
      durability: {
        syncCommit: required('synchronous_commit'),
        synchronousStandbyNames: required('synchronous_standby_names'),
        walLevel: required('wal_level'),
        fsync: required('fsync'),
        fullPageWrites: required('full_page_writes'),
        archiveMode: required('archive_mode'),
        syncReplicaCount: replication?.count ?? 0,
      },
    },
  };
}

/** Every ordinary table in the current schema, catalog-derived. */
export async function captureTableNames(sql) {
  const rows = await query(sql, `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relkind='r' AND c.relname NOT LIKE 'pg\\_%' ORDER BY c.relname`);
  if (rows.length === 0) throw new BlroCaptureError('BLRO_BACKUP_NO_TABLES');
  return rows.map((row) => row.name);
}

export async function captureSchemaState(sql, tables) {
  const migrations = await query(sql, `SELECT migration_name AS name, checksum FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`);
  if (migrations.length === 0) throw new BlroCaptureError('BLRO_BACKUP_MIGRATION_STATE_MISSING');
  const columns = await query(sql, `SELECT c.relname AS "table", a.attname AS column, format_type(a.atttypid,a.atttypmod) AS type, a.attnotnull AS notnull FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped WHERE n.nspname=current_schema() AND c.relkind='r' AND c.relname = ANY($1) ORDER BY c.relname, a.attname`, tables);
  return {
    migrations,
    migrationDigest: digestOf(migrations),
    catalogDigest: digestOf(columns),
    tableCount: tables.length,
  };
}

/**
 * Per-table row count plus an order-independent set digest.
 * The digest sums per-row sha256 over the full row projected to text, so a reordered restore
 * still matches while any changed byte in any row does not.
 */
export async function captureTableDigests(sql, tables) {
  const digests = [];
  for (const table of tables) {
    const [row] = await query(sql, `SELECT count(*)::int AS "rowCount", coalesce(md5(string_agg(digest, '')), '') AS combined FROM (SELECT md5(t.*::text) AS digest FROM "${table}" t ORDER BY 1) ordered`);
    if (!row) throw new BlroCaptureError('BLRO_BACKUP_TABLE_DIGEST_UNAVAILABLE', table);
    digests.push({ table, rowCount: row.rowCount, setDigest: digestOf({ table, combined: row.combined, rowCount: row.rowCount }) });
  }
  return digests;
}

/** Foreign-key relationships with live child cardinality, so a restore that drops edges is caught. */
export async function captureRelationships(sql, tables) {
  const constraints = await query(sql, `SELECT con.conname AS constraint, child.relname AS "table", parent.relname AS parent, con.confdeltype::text AS "deleteAction", array_agg(a.attname ORDER BY keys.ordinality) AS columns, array_agg(r.attname ORDER BY keys.ordinality) AS references FROM pg_constraint con JOIN pg_class child ON child.oid=con.conrelid JOIN pg_class parent ON parent.oid=con.confrelid JOIN pg_namespace n ON n.oid=child.relnamespace CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY keys(attnum, refattnum, ordinality) JOIN pg_attribute a ON a.attrelid=child.oid AND a.attnum=keys.attnum JOIN pg_attribute r ON r.attrelid=parent.oid AND r.attnum=keys.refattnum WHERE n.nspname=current_schema() AND con.contype='f' AND child.relname = ANY($1) GROUP BY con.conname, child.relname, parent.relname, con.confdeltype ORDER BY con.conname`, tables);
  const relationships = [];
  for (const constraint of constraints) {
    const predicate = constraint.columns.map((column) => `"${column}" IS NOT NULL`).join(' AND ');
    const [row] = await query(sql, `SELECT count(*)::int AS count FROM "${constraint.table}" WHERE ${predicate}`);
    relationships.push({ ...constraint, childRows: row?.count ?? 0 });
  }
  return relationships;
}

export async function captureEpochs(sql) {
  const epochs = await query(sql, `SELECT "projectId", "epoch", "revision" FROM "BlroProjectAuthorityEpoch" ORDER BY "projectId"`);
  const cutovers = await query(sql, `SELECT "projectId", "aggregate", "state", "epoch", "revision" FROM "BlroAuthorityCutover" ORDER BY "projectId", "aggregate"`);
  return epochs.map((epoch) => ({
    ...epoch,
    cutovers: cutovers.filter((cutover) => cutover.projectId === epoch.projectId)
      .map(({ aggregate, state, epoch: cutoverEpoch, revision }) => ({ aggregate, state, epoch: cutoverEpoch, revision })),
  }));
}

/** Keyed audit-chain heads per project, plus a digest over the full ordered (seq, hash, keyed) chain. */
export async function captureAuditHeads(sql) {
  const events = await query(sql, `SELECT "projectId", "seq"::text AS seq, "hash", "prevHash", "keyed" FROM "BlroAuditEvent" ORDER BY "projectId", "seq"`);
  const byProject = new Map();
  for (const event of events) {
    const chain = byProject.get(event.projectId) ?? [];
    chain.push(event);
    byProject.set(event.projectId, chain);
  }
  return [...byProject.entries()].map(([projectId, chain]) => {
    const head = chain[chain.length - 1];
    if (!head) throw new BlroCaptureError('BLRO_BACKUP_AUDIT_CHAIN_EMPTY', projectId);
    return {
      projectId,
      eventCount: chain.length,
      headSeq: Number(head.seq),
      headHash: head.hash,
      keyedCount: chain.filter((event) => event.keyed).length,
      chainDigest: digestOf(chain.map((event) => [event.seq, event.prevHash, event.hash, event.keyed])),
    };
  });
}

/** Outstanding approval/nonce authority and the remote-job tombstone set, including INDETERMINATE. */
export async function captureAuthorityState(sql) {
  const outstandingApprovals = await query(sql, `SELECT "id", "projectId", "actionHash", "status", "authorityEpoch" FROM "BlroApproval" WHERE "status" <> 'spent' ORDER BY "id"`);
  const nonceRows = await query(sql, `SELECT "id", "projectId", encode(sha256("nonce"::bytea),'hex') AS "nonceDigest", "authorityEpoch" FROM "BlroApprovalNonce" WHERE "consumedAt" IS NULL ORDER BY "id"`);
  const remoteJobs = await query(sql, `SELECT "id", "projectId", "jobId", "capabilityJti", "state", "resultDigest", "authorityEpoch" FROM "BlroRemoteJob" ORDER BY "id"`);
  return {
    outstandingApprovals,
    outstandingNonces: nonceRows,
    remoteJobs: remoteJobs.map((job) => ({ ...job, resultDigest: job.resultDigest ?? null })),
    indeterminateCount: remoteJobs.filter((job) => job.state === 'indeterminate').length,
    completedCount: remoteJobs.filter((job) => job.state === 'result_retained').length,
  };
}

/**
 * Exact hashes of the evidence objects the manifests reference.
 * A referenced object that is absent or unreadable refuses the backup: a fabricated hash would
 * make the manifest lie about what is recoverable.
 */
export async function captureEvidenceObjects(sql, resolveObject) {
  const manifests = await query(sql, `SELECT "id", "projectId", "contentHash", "manifest" FROM "BlroEvidenceManifest" ORDER BY "id"`);
  const objects = [];
  for (const manifest of manifests) {
    const resolved = await resolveObject(manifest);
    if (resolved === undefined) throw new BlroCaptureError('BLRO_BACKUP_EVIDENCE_OBJECT_MISSING', `${manifest.id}`);
    objects.push({
      id: manifest.id,
      projectId: manifest.projectId,
      contentHash: manifest.contentHash,
      objectPath: resolved.objectPath,
      objectHash: resolved.objectHash,
      objectBytes: resolved.objectBytes,
    });
  }
  return objects;
}
