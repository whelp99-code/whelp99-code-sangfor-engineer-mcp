import { existsSync, globSync } from 'node:fs';

export const MANDATORY_POSTGRES_AUXILIARY_FILES = [
  'tests/authority-runtime-database-probe.test.ts',
  'tests/blro-authority-domain-apis.test.ts',
  'tests/blro-authority-runtime.test.ts',
  'tests/blro-remote-dispatcher.test.ts',
  'tests/blro-two-replica.test.ts',
  'tests/mandatory-postgres/authority-concurrency.test.ts',
  'tests/mandatory-postgres/local-writer-refusal.test.ts',
  'tests/nonce-gate-wiring.test.ts',
  'tests/store.test.ts',
] as const;

/**
 * Test files that open a PostgreSQL connection unconditionally, so they FAIL
 * rather than skip when no database is reachable. `vitest.config.ts` excludes
 * exactly this set from the default suite and the mandatory profile owns it;
 * `assertDatabaseLanePartition` proves the two lanes never drift apart.
 */
export const EXTERNAL_DATABASE_ONLY_TEST_DIRECTORY = 'tests/mandatory-postgres';

export const EXTERNAL_DATABASE_ONLY_AUXILIARY_FILES = [
  'tests/authority-runtime-database-probe.test.ts',
  'tests/blro-authority-domain-apis.test.ts',
  'tests/blro-authority-runtime.test.ts',
] as const;

export class MandatoryPostgresFileError extends Error {
  readonly name = 'MandatoryPostgresFileError';
}

export function externalDatabaseOnlyTestFiles(
  directoryFiles: readonly string[] = globSync(`${EXTERNAL_DATABASE_ONLY_TEST_DIRECTORY}/**/*.test.ts`),
): readonly string[] {
  const files = [...EXTERNAL_DATABASE_ONLY_AUXILIARY_FILES, ...directoryFiles].sort();
  if (new Set(files).size !== files.length) throw new MandatoryPostgresFileError('MANDATORY_POSTGRES_DUPLICATE_FILE');
  for (const file of files) if (!existsSync(file)) throw new MandatoryPostgresFileError(`MANDATORY_POSTGRES_FILE_MISSING: ${file}`);
  return files;
}

export type DatabaseLaneSelections = {
  readonly onDisk: readonly string[];
  readonly defaultSelection: readonly string[];
  readonly mandatorySelection: readonly string[];
  readonly externalDatabaseOnly: readonly string[];
};

/**
 * Refuses any drift between the default and mandatory suite lanes: an
 * external-database file that leaked back into `pnpm test`, a declared file the
 * mandatory profile stopped enforcing, or a suite dropped from the default lane
 * that nobody declared. Together those three refusals make the two selections
 * disjoint and jointly complete over everything on disk.
 */
export function assertDatabaseLanePartition(selections: DatabaseLaneSelections): void {
  const external = [...selections.externalDatabaseOnly].sort();
  const defaultSelection = new Set(selections.defaultSelection);
  const mandatory = new Set(selections.mandatorySelection);

  const leaked = external.filter((file) => defaultSelection.has(file));
  if (leaked.length > 0) throw new MandatoryPostgresFileError(`DATABASE_LANE_NOT_DISJOINT: ${leaked.join(', ')}`);

  const unenforced = external.filter((file) => !mandatory.has(file));
  if (unenforced.length > 0) throw new MandatoryPostgresFileError(`DATABASE_LANE_UNENFORCED: ${unenforced.join(', ')}`);

  const externalSet = new Set(external);
  const undeclared = [...selections.onDisk]
    .filter((file) => !defaultSelection.has(file) && !externalSet.has(file)).sort();
  if (undeclared.length > 0) throw new MandatoryPostgresFileError(`DATABASE_LANE_UNDECLARED_EXCLUSION: ${undeclared.join(', ')}`);
}

export function mandatoryPostgresFiles(
  postgresFiles: readonly string[] = globSync('tests/**/*postgres*.test.ts').sort(),
  auxiliaryFiles: readonly string[] = MANDATORY_POSTGRES_AUXILIARY_FILES,
): readonly string[] {
  const expectedPostgres = [...new Set(postgresFiles)].sort();
  if (expectedPostgres.length !== postgresFiles.length) throw new MandatoryPostgresFileError('MANDATORY_POSTGRES_DUPLICATE_FILE');
  const files = [...expectedPostgres, ...auxiliaryFiles].sort();
  if (new Set(files).size !== files.length) throw new MandatoryPostgresFileError('MANDATORY_POSTGRES_DUPLICATE_FILE');
  for (const file of files) if (!existsSync(file)) throw new MandatoryPostgresFileError(`MANDATORY_POSTGRES_FILE_MISSING: ${file}`);
  return files;
}

export function assertMandatoryPostgresCoverage(
  discoveredPostgresFiles: readonly string[],
  selectedFiles: readonly string[],
): void {
  const selected = new Set(selectedFiles);
  const missing = discoveredPostgresFiles.filter((file) => !selected.has(file));
  if (missing.length > 0) throw new MandatoryPostgresFileError(`MANDATORY_POSTGRES_FILE_OMITTED: ${missing.join(', ')}`);
}
