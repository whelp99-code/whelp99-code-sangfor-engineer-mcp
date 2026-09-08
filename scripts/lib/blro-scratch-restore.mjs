// Owned scratch-database lifecycle shared by backup publication and the restore drill.
// The operation returns only after the newly-created database has been dropped successfully.
import { PrismaClient } from '@prisma/client';
import { connectionUrl, runPgTool } from './blro-backup-runtime.mjs';
import { BlroRestoreVerifyError } from './blro-restore-verify.mjs';

function quotedIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

/** Refuse an existing target: only a database created by this invocation can ever be dropped. */
export function assertScratchTargetAbsent(admin, database) {
  const databaseLiteral = database.replaceAll("'", "''");
  const rows = runPgTool('psql', admin, [
    '--dbname', admin.database, '--no-psqlrc', '--tuples-only', '--no-align',
    '--command', `SELECT count(*) FROM pg_database WHERE datname = '${databaseLiteral}'`,
  ]).trim();
  if (rows !== '0') throw new BlroRestoreVerifyError('BLRO_DRILL_TARGET_EXISTS_DIRTY', database);
}

/** Create, restore, use, disconnect, and drop one owned scratch database. */
export async function withScratchRestore(options, operation) {
  assertScratchTargetAbsent(options.admin, options.target.database);
  const database = quotedIdentifier(options.target.database);
  const owner = quotedIdentifier(options.admin.user);
  let created = false;
  let scratch;
  try {
    runPgTool('psql', options.admin, [
      '--dbname', options.admin.database, '--no-psqlrc', '--command',
      `CREATE DATABASE ${database} OWNER ${owner}`,
    ]);
    created = true;
    runPgTool('pg_restore', options.target, [
      '--dbname', options.target.database, '--exit-on-error', '--no-owner', '--no-privileges',
      options.dumpPath,
    ]);
    scratch = new PrismaClient({ datasources: { db: { url: connectionUrl(options.target) } } });
    return await operation(scratch);
  } finally {
    try {
      await scratch?.$disconnect();
    } finally {
      if (created) {
        runPgTool('psql', options.admin, [
          '--dbname', options.admin.database, '--no-psqlrc', '--command',
          `DROP DATABASE ${database} WITH (FORCE)`,
        ]);
      }
    }
  }
}
