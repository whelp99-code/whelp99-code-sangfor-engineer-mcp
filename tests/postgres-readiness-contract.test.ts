import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AUTHORITY_MANIFEST } from '../packages/sangfor-authority/src/migration-manifest.js';
import {
  assertMandatoryPostgresCoverage,
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
