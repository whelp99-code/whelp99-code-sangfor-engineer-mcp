import { spawnSync } from 'node:child_process';
import { globSync, readFileSync } from 'node:fs';
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
    expect(external.length).toBe(6);

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
    expect(`${result.stdout}${result.stderr}`).toContain('MANDATORY_POSTGRES_DATABASE_REQUIRED');
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
