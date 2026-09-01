import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUTHORITY_MANIFEST } from '../packages/sangfor-authority/src/migration-manifest.js';
import {
  assertDatabaseLanePartition,
  assertMandatoryPostgresCoverage,
  externalDatabaseOnlyTestFiles,
  mandatoryPostgresFiles,
} from '../scripts/lib/mandatory-postgres-files.js';
import {
  deriveScopedAuthorityModels,
  deriveTenantProjectModels,
} from '../scripts/lib/scoped-authority-models.js';

describe('Todo 24 authoritative PostgreSQL scope derivation', () => {
  it('Given the canonical schema and manifest, When scoped models are derived, Then every project authority model is included without legacy tables', () => {
    // Given
    const schema = readFileSync('prisma/schema.prisma', 'utf8');

    // When
    const models = deriveScopedAuthorityModels(schema, AUTHORITY_MANIFEST);

    // Then
    expect(models).toContain('BlroProject');
    expect(models).toContain('BlroClientEnrollment');
    expect(models).toContain('BlroRemoteJob');
    expect(models).toContain('BlroServiceRegistry');
    expect(models).not.toContain('SangforConfigPlan');
    expect(new Set(models).size).toBe(models.length);
    for (const model of deriveTenantProjectModels(schema, models)) {
      expect(model.projectRelationFields).toEqual(['tenantId', 'projectId']);
      expect(model.projectReferenceFields).toEqual(['tenantId', 'id']);
    }
  });

  it('Given a manifest target without project scope, When models are derived, Then the authority gap is refused', () => {
    // Given
    const schema = 'model BlroProject {\n id String @id\n}\nmodel BlroRecord {\n id String @id\n}\n';
    const manifest = {
      version: 1,
      entries: [{
        classification: 'authoritative', projectScope: 'required', rlsRequired: true,
        target: { kind: 'postgres', tables: ['BlroRecord'] },
      }],
    } as const;

    // When / Then
    expect(() => deriveScopedAuthorityModels(schema, manifest)).toThrow('AUTHORITY_TARGET_UNSCOPED: BlroRecord');
  });
});

describe('Todo 24 mandatory PostgreSQL file census', () => {
  it('Given every postgres-named test and required auxiliary, When selected, Then the set is exact and duplicate-free', () => {
    // Given / When
    const files = mandatoryPostgresFiles();
    const postgresFiles = files.filter((file) => file.includes('postgres'));

    // Then
    expect(new Set(files).size).toBe(files.length);
    expect(postgresFiles).toEqual(expect.arrayContaining([
      'tests/postgres-no-db-local-writers.test.ts',
      'tests/postgres-nonce-store.test.ts',
      'tests/postgres-readiness-contract.test.ts',
    ]));
  });

  it('Given one postgres filename is omitted, When coverage is checked, Then the mutation is refused', () => {
    // Given
    const discovered = ['tests/a-postgres.test.ts', 'tests/b-postgres.test.ts'];

    // When / Then
    expect(() => assertMandatoryPostgresCoverage(discovered, discovered.slice(1)))
      .toThrow('MANDATORY_POSTGRES_FILE_OMITTED: tests/a-postgres.test.ts');
  });
});

describe('Todo 24 database lane partition gate', () => {
  // Reads the real default config rather than re-deriving its globs, so a config
  // edit that re-admits a database suite into `pnpm test` fails this gate.
  function defaultSuiteSelection(): readonly string[] {
    const result = spawnSync('node_modules/.bin/vitest', ['list', '--config', 'vitest.config.ts', '--filesOnly'], {
      cwd: process.cwd(), env: process.env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    });
    if (result.status !== 0) throw new Error(`vitest list failed: ${result.stdout}${result.stderr}`);
    return result.stdout.split('\n').map((line) => line.trim()).filter((line) => line.endsWith('.test.ts')).sort();
  }

  const drifted = {
    onDisk: ['tests/pure.test.ts', 'tests/external-db.test.ts'],
    defaultSelection: ['tests/pure.test.ts'],
    mandatorySelection: ['tests/external-db.test.ts'],
    externalDatabaseOnly: ['tests/external-db.test.ts'],
  } as const;

  it('Given the real default and mandatory configs, When both lanes are selected, Then the default lane is exactly the on-disk suites minus the external-database files', () => {
    // Given
    const onDisk = globSync('tests/**/*.test.ts').sort();
    const external = externalDatabaseOnlyTestFiles();
    expect(external.length).toBe(7);

    // When
    const defaultSelection = defaultSuiteSelection();

    // Then
    expect(defaultSelection).toEqual(onDisk.filter((file) => !external.includes(file)));
    expect(() => assertDatabaseLanePartition({
      onDisk, defaultSelection, mandatorySelection: mandatoryPostgresFiles(), externalDatabaseOnly: external,
    })).not.toThrow();
  });

  it('Given an external-database file leaks back into the default suite, When the gate runs, Then the overlap is refused', () => {
    // Given / When / Then
    expect(() => assertDatabaseLanePartition({
      ...drifted, defaultSelection: ['tests/pure.test.ts', 'tests/external-db.test.ts'],
    })).toThrow('DATABASE_LANE_NOT_DISJOINT: tests/external-db.test.ts');
  });

  it('Given the mandatory profile stops enforcing a declared external-database file, When the gate runs, Then the gap is refused', () => {
    // Given / When / Then
    expect(() => assertDatabaseLanePartition({ ...drifted, mandatorySelection: [] }))
      .toThrow('DATABASE_LANE_UNENFORCED: tests/external-db.test.ts');
  });

  it('Given a suite is dropped from the default lane without being declared external-database, When the gate runs, Then the silent exclusion is refused', () => {
    // Given / When / Then
    expect(() => assertDatabaseLanePartition({
      ...drifted, onDisk: [...drifted.onDisk, 'tests/silently-dropped.test.ts'],
    })).toThrow('DATABASE_LANE_UNDECLARED_EXCLUSION: tests/silently-dropped.test.ts');
  });
});

describe('Todo 24 mandatory PostgreSQL profile refusal', () => {
  it('Given DATABASE_URL is absent, When the mandatory profile starts, Then it exits nonzero before tests', () => {
    // Given / When
    const environment = { ...process.env };
    delete environment['DATABASE_URL'];
    delete environment['BLRO_OWNER_DATABASE_URL'];
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/run-mandatory-postgres-tests.ts', '--require'], {
      cwd: process.cwd(), env: environment, encoding: 'utf8',
    });

    // Then
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('MANDATORY_POSTGRES_SELECTION: 29 exact files');
    expect(`${result.stdout}${result.stderr}`).toContain('MANDATORY_POSTGRES_DATABASE_REQUIRED');
  });

  it('Given a failing child emits output, When the mandatory profile runs it, Then output and the exact exit are observable', async () => {
    // Given
    const bindir = mkdtempSync(join(tmpdir(), 'mandatory-postgres-runner-'));
    const psql = `#!/bin/sh
if [ "$1" = "--version" ]; then exit 0; fi
case "$*" in *extversion*) printf '0.8.1\\n' ;; *) printf '1\\n' ;; esac
`;
    const versionOnly = '#!/bin/sh\nexit 0\n';
    const pnpm = `#!/bin/sh
if [ "$1 $2 $3" = "exec prisma migrate" ]; then
  printf 'FAKE_MIGRATION_STARTED\\n' >&2
  if IFS= read -r reply && [ "$reply" = "continue" ]; then exit 9; fi
  exit 7
fi
exit 88
`;
    for (const [name, contents] of [['psql', psql], ['pg_dump', versionOnly], ['pg_restore', versionOnly], ['pnpm', pnpm]]) {
      writeFileSync(join(bindir, name), contents, { mode: 0o755 });
    }
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/run-mandatory-postgres-tests.ts', '--require'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PG_BINDIR: bindir,
        DATABASE_URL: 'postgresql://runtime@fake/blro',
        BLRO_OWNER_DATABASE_URL: 'postgresql://owner@fake/blro',
        BLRO_BACKUP_DATABASE_URL: 'postgresql://backup@fake/blro',
        BLRO_SCRATCH_ADMIN_DATABASE_URL: 'postgresql://admin@fake/postgres',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      if (text.includes('FAKE_MIGRATION_STARTED')) child.stdin.write('continue\n');
    });

    try {
      // When
      const [status] = await once(child, 'exit', { signal: AbortSignal.timeout(5_000) });

      // Then
      expect(status).not.toBe(0);
      expect(output).toContain('FAKE_MIGRATION_STARTED');
      expect(output).toContain('exit=9');
    } finally {
      child.kill();
      rmSync(bindir, { recursive: true, force: true });
    }
  });

  it('Given the require flag is omitted, When the mandatory profile starts, Then it exits nonzero', () => {
    // Given / When
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/run-mandatory-postgres-tests.ts'], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_URL: 'postgresql://unused/unused' }, encoding: 'utf8',
    });

    // Then
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('MANDATORY_POSTGRES_REQUIRE_FLAG_REQUIRED');
  });
});
