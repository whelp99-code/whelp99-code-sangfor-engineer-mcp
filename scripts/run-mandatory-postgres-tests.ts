import { spawnSync } from 'node:child_process';
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
  const environment = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    BLRO_OWNER_DATABASE_URL: ownerUrl,
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
    arguments: ['exec', 'vitest', 'run', '--config', 'vitest.postgres.config.ts', '--reporter=json', ...tests],
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
