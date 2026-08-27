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

export class MandatoryPostgresFileError extends Error {
  readonly name = 'MandatoryPostgresFileError';
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
