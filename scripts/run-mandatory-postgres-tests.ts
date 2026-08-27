import { spawnSync } from 'node:child_process';
import { existsSync, globSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { z } from 'zod';
import {
  assertMandatoryPostgresCoverage,
  mandatoryPostgresFiles,
} from './lib/mandatory-postgres-files.js';

const ReportSchema = z.object({
  numTotalTestSuites: z.number().int().positive(),
  numPassedTestSuites: z.number().int().nonnegative(),
  numTotalTests: z.number().int().positive(),
  numPendingTests: z.number().int().nonnegative(),
  success: z.boolean(),
  testResults: z.array(z.object({ name: z.string() })),
});

type Command = {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
};

class MandatoryPostgresError extends Error {
  readonly name = 'MandatoryPostgresError';
}

const REQUIRED_BINARIES = ['psql', 'pg_dump', 'pg_restore'] as const;

/**
 * Resolves a PostgreSQL client bindir the runner OWNS, rather than trusting the
 * caller's PATH. Order: an explicit override, `pg_config --bindir`, the rootless
 * pgserver install, then the common platform locations.
 */
function resolvePostgresBindir(): string {
  const candidates: string[] = [];
  const override = process.env['PG_BINDIR']?.trim();
  if (override) candidates.push(override);
  const pgConfig = spawnSync('pg_config', ['--bindir'], { encoding: 'utf8' });
  if (pgConfig.status === 0) candidates.push(pgConfig.stdout.trim());
  candidates.push(...globSync('/tmp/pgvenv/lib/python*/site-packages/pgserver/pginstall/bin'));
  candidates.push(...globSync(`${process.env['HOME'] ?? ''}/.local/**/pgserver/pginstall/bin`));
  candidates.push(...globSync('/usr/lib/postgresql/*/bin'), '/usr/local/bin', '/usr/bin');
  for (const candidate of candidates) {
    if (candidate && REQUIRED_BINARIES.every((name) => existsSync(join(candidate, name)))) {
      return candidate;
    }
  }
  throw new MandatoryPostgresError(
    `MANDATORY_POSTGRES_BINARIES_REQUIRED: ${REQUIRED_BINARIES.join(', ')}`,
  );
}

/**
 * The replay suite shells out to psql and the backup suites to pg_dump and
 * pg_restore; a missing client silently reported a null exit status that read as
 * catalog drift. Prove all three run from the resolved bindir.
 */
function assertBinariesUsable(bindir: string): void {
  for (const name of REQUIRED_BINARIES) {
    const binary = join(bindir, name);
    if (spawnSync(binary, ['--version'], { encoding: 'utf8' }).status !== 0) {
      throw new MandatoryPostgresError(`MANDATORY_POSTGRES_BINARY_UNUSABLE: ${binary}`);
    }
  }
}

function backupPassword(): string {
  return process.env['BLRO_BACKUP_PASSWORD']?.trim() ?? 'blro_backup_local';
}

/** Rewrites the owner URL onto another role, keeping host/port/database. */
function deriveRoleUrl(
  ownerUrl: string,
  role: string,
  password: string,
  database?: string,
): string {
  const url = new URL(ownerUrl);
  url.username = role;
  url.password = password;
  if (database !== undefined) url.pathname = `/${database}`;
  return url.toString();
}

/** Proves the derived credential actually connects before the suites run. */
function assertReachable(psql: string, url: string, refusal: string): void {
  const probe = spawnSync(psql, [url, '-Atc', 'SELECT 1'], { encoding: 'utf8' });
  if (probe.status !== 0) throw new MandatoryPostgresError(refusal);
}

function assertPgvectorAvailable(psql: string, ownerUrl: string): void {
  const probe = spawnSync(psql, [ownerUrl, '-Atc', `SELECT extversion FROM pg_extension WHERE extname='vector'`], { encoding: 'utf8' });
  if (probe.status !== 0 || probe.stdout.trim() !== '0.8.1') {
    throw new MandatoryPostgresError('MANDATORY_POSTGRES_PGVECTOR_0_8_1_REQUIRED');
  }
}

function run(command: Command): string {
  const result = spawnSync(command.executable, command.arguments, {
    cwd: process.cwd(), env: command.environment, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout}${result.stderr}`;
  if (result.status !== 0) throw new MandatoryPostgresError(output.trim() || `command failed: ${command.executable}`);
  return output;
}

function main(): void {
  if (!process.argv.includes('--require')) throw new MandatoryPostgresError('MANDATORY_POSTGRES_REQUIRE_FLAG_REQUIRED');
  const databaseUrl = process.env['DATABASE_URL']?.trim();
  const ownerUrl = process.env['BLRO_OWNER_DATABASE_URL']?.trim();
  if (!databaseUrl || !ownerUrl) throw new MandatoryPostgresError('MANDATORY_POSTGRES_DATABASE_REQUIRED');
  // Backup reader and scratch admin are mandatory. The runner DERIVES them from
  // the owner URL when the operator has not supplied them, so the two
  // backup/restore suites can never silently self-skip for want of a URL.
  const backupUrl = process.env['BLRO_BACKUP_DATABASE_URL']?.trim()
    ?? deriveRoleUrl(ownerUrl, 'blro_backup', backupPassword());
  const scratchAdminUrl = process.env['BLRO_SCRATCH_ADMIN_DATABASE_URL']?.trim()
    ?? deriveRoleUrl(ownerUrl, 'postgres', process.env['PGPASSWORD']?.trim() ?? '', 'postgres');
  // Own the toolchain before selecting anything: the suites must never depend on
  // whatever happens to be on the caller's PATH.
  const bindir = resolvePostgresBindir();
  assertBinariesUsable(bindir);
  const psqlBinary = join(bindir, 'psql');
  assertReachable(psqlBinary, backupUrl, 'MANDATORY_POSTGRES_BACKUP_ROLE_UNUSABLE');
  assertReachable(psqlBinary, scratchAdminUrl, 'MANDATORY_POSTGRES_SCRATCH_ADMIN_UNUSABLE');
  assertPgvectorAvailable(psqlBinary, ownerUrl);
  const environment = {
    ...process.env,
    // Every child inherits the resolved bindir first on PATH.
    PATH: `${bindir}:${process.env['PATH'] ?? ''}`,
    DATABASE_URL: databaseUrl,
    BLRO_OWNER_DATABASE_URL: ownerUrl,
    BLRO_BACKUP_DATABASE_URL: backupUrl,
    BLRO_SCRATCH_ADMIN_DATABASE_URL: scratchAdminUrl,
    PSQL_BIN: psqlBinary,
    AUTHORITY_CUTOVER_DATABASE_URL: databaseUrl,
    SANGFOR_RUN_STORE_IT: '1',
    SANGFOR_REQUIRE_POSTGRES_TESTS: '1',
  };
  run({ executable: 'pnpm', arguments: ['exec', 'prisma', 'migrate', 'deploy'], environment: { ...environment, DATABASE_URL: ownerUrl } });
  run({ executable: 'pnpm', arguments: ['run', 'db:generate'], environment });

  const tests = mandatoryPostgresFiles();
  assertMandatoryPostgresCoverage(tests.filter((file) => file.includes('postgres')), tests);
  const report = ReportSchema.parse(JSON.parse(run({
    executable: 'pnpm',
    arguments: ['exec', 'vitest', 'run', '--config', 'vitest.postgres.config.ts',
      '--maxWorkers=1', '--reporter=json', ...tests],
    environment,
  })));
  const executed = report.testResults.map((result) => tests.find((file) => result.name.endsWith(file))).filter((file) => file !== undefined);
  if (!report.success || report.numPendingTests !== 0 || new Set(executed).size !== tests.length) {
    throw new MandatoryPostgresError(`MANDATORY_POSTGRES_CENSUS_REFUSED: selected=${tests.length} executed=${new Set(executed).size} pending=${report.numPendingTests}`);
  }
  const verifier = run({
    executable: process.execPath,
    arguments: ['--import', 'tsx', 'scripts/verify-rls-isolation.ts', '--require'],
    environment,
  });
  process.stdout.write(`MANDATORY_POSTGRES_PASS (${tests.length} exact files, ${report.numTotalTests} tests, 0 skipped: ${tests.join(', ')})\n${verifier}`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
