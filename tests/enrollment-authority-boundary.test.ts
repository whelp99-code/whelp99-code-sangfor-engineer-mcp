import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const browserRoot = join(ROOT, 'packages/sangfor-browser-contracts/src');
const appRoot = join(ROOT, 'apps');
const forbiddenBrowserRuntime = [
  '$queryRawUnsafe', '$executeRawUnsafe', 'Prisma', 'X509Certificate',
  'PostgresEnrollment', 'EnrollmentSqlExecutor',
] as const;
const forbiddenAppSql = [
  '$queryRawUnsafe', '$executeRawUnsafe', '$queryRaw`', '$executeRaw`',
] as const;

function sourceFiles(root: string): readonly string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.[cm]?[jt]sx?$/u.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

describe('enrollment authority architecture boundary', () => {
  it('keeps browser contracts JSON-only and all application adapters SQL-free', () => {
    const browserViolations = sourceFiles(browserRoot).flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      return forbiddenBrowserRuntime
        .filter((token) => source.includes(token))
        .map((token) => `${path}:${token}`);
    });
    const appSql = sourceFiles(appRoot).flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      return forbiddenAppSql.filter((token) => source.includes(token)).map((token) => `${path}:${token}`);
    });

    expect(browserViolations).toEqual([]);
    expect(appSql).toEqual([]);
  });

  it('defines the public PostgreSQL composition at authority enrollment-store', () => {
    const source = readFileSync(join(ROOT, 'packages/sangfor-authority/src/enrollment-store.ts'), 'utf8');
    expect(source).toMatch(/export class PostgresEnrollmentRegistry/u);
  });

  it('keeps the HTTP router on the narrow runtime enrollment accessor', () => {
    const source = readFileSync(join(ROOT, 'apps/control-tower/src/authority-enrollment-routes.ts'), 'utf8');
    expect(source).toContain('authorityRuntime?.enrollments()');
    expect(source).not.toMatch(/Prisma|\$queryRaw|\$executeRaw|\.resources\(\)/u);
  });
});
