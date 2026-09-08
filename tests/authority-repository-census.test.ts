import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadRepositoryCensus } from '../packages/sangfor-authority/src/repository-census.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'authority-ast-census-'));
  roots.push(root);
  mkdirSync(join(root, 'prisma/migrations/fixture'), { recursive: true });
  mkdirSync(join(root, 'packages/example/src'), { recursive: true });
  writeFileSync(join(root, 'packages/example/package.json'), JSON.stringify({ name: '@sangfor/example' }));
  writeFileSync(join(root, 'prisma/schema.prisma'), 'model Example {\n id String @id\n projectId String\n}\n');
  writeFileSync(join(root, 'prisma/migrations/fixture/migration.sql'), [
    'CREATE TABLE "Example" ("id" TEXT PRIMARY KEY, "projectId" TEXT NOT NULL);',
    'ALTER TABLE "Example" ENABLE ROW LEVEL SECURITY;',
    'ALTER TABLE "Example" FORCE ROW LEVEL SECURITY;',
    'CREATE POLICY "Example_scope" ON "Example" USING ("projectId" = current_setting(\'app.project_id\', true)) WITH CHECK ("projectId" = current_setting(\'app.project_id\', true));',
  ].join('\n'));
  return root;
}

function writeSource(root: string, path: string, source: string): void {
  const target = join(root, path);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, source);
}

describe('authority repository AST census', () => {
  it('discovers Todo20AddedLedger at unlimited nesting while ignoring comments and strings', () => {
    const root = fixtureRoot();
    const nested = `scripts/${Array.from({ length: 14 }, (_, index) => `level-${index}`).join('/')}/Todo20AddedLedger.ts`;
    writeSource(root, nested, [
      "import { appendFile } from 'node:fs/promises';",
      'export class Todo20AddedLedger {',
      "  async record(): Promise<void> { await appendFile('state.jsonl', '{}'); }",
      '}',
      "const misleading = \"writeFileSync('fake.json', 'x')\";",
      "// appendFileSync('comment.jsonl', 'x')",
      'void misleading;',
    ].join('\n'));
    writeSource(root, 'scripts/false-positive.ts', [
      "const prose = \"renameSync('a', 'b')\";",
      "/* createWriteStream('fake') */",
      'void prose;',
    ].join('\n'));

    const census = loadRepositoryCensus(root);

    expect(census.references).toContain(`persist:${nested}#Todo20AddedLedger`);
    expect(census.references.some((reference) => reference.includes('false-positive'))).toBe(false);
  });

  it('detects sync/async writes, append, rename, open, streams, and atomic APIs by AST call shape', () => {
    const root = fixtureRoot();
    writeSource(root, 'packages/example/src/writers.ts', [
      "import { appendFileSync, createWriteStream, openSync, renameSync, writeFileSync } from 'node:fs';",
      "import { writeFile, open } from 'node:fs/promises';",
      "import { writeFileAtomicSync } from '@sangfor/shared';",
      "export function syncWriter() { writeFileSync('a', 'x'); appendFileSync('a', 'x'); renameSync('a', 'b'); openSync('a', 'w'); createWriteStream('a'); writeFileAtomicSync('a', 'x'); }",
      "export async function asyncWriter() { await writeFile('a', 'x'); await open('a', 'w'); }",
    ].join('\n'));

    const references = loadRepositoryCensus(root).references;

    expect(references).toContain('persist:packages/example/src/writers.ts#syncWriter');
    expect(references).toContain('persist:packages/example/src/writers.ts#asyncWriter');
  });

  it('follows declared persistence helpers to their callsites', () => {
    const root = fixtureRoot();
    writeSource(root, 'packages/example/src/helper.ts', [
      "import { appendFileSync } from 'node:fs';",
      "function persistLedger() { appendFileSync('ledger.jsonl', 'x'); }",
      'export function saveLedger() { persistLedger(); }',
    ].join('\n'));

    const references = loadRepositoryCensus(root).references;

    expect(references).toContain('persist:packages/example/src/helper.ts#persistLedger');
    expect(references).toContain('persist:packages/example/src/helper.ts#saveLedger');
  });

  it('changes the semantic digest when a recognized RunStore method is added', () => {
    const root = fixtureRoot();
    const path = 'packages/example/src/run-store.ts';
    writeSource(root, path, "import { writeFileSync } from 'node:fs'; export class RunStore { save() { writeFileSync('run.json', '{}'); } }");
    const before = loadRepositoryCensus(root);
    writeSource(root, path, "import { writeFileSync } from 'node:fs'; export class RunStore { save() { writeFileSync('run.json', '{}'); } archive(): void {} }");

    const after = loadRepositoryCensus(root);

    expect(after.references).toEqual(before.references);
    expect(after.digest).not.toBe(before.digest);
  });

  it('detects semantic credential env and path boundaries without timeout/count false positives', () => {
    const root = fixtureRoot();
    writeSource(root, 'packages/example/src/credentials.ts', [
      "import { join } from 'node:path';",
      "export function sessionState() { return process.env['SANGFOR_BROWSER_SESSION_STATE_PATH']; }",
      "export function apiToken() { return process.env.SANGFOR_API_TOKEN; }",
      "export function clientCert() { return process.env.SANGFOR_CLIENT_CERT_PATH; }",
      "export function cookieStorage() { return join('runtime', 'browser-cookie-storage.json'); }",
      "export function timeout() { return process.env.SANGFOR_BROWSER_SESSION_TIMEOUT; }",
      "export function count() { return process.env.SANGFOR_CDP_PROFILE_COUNT; }",
    ].join('\n'));

    const references = loadRepositoryCensus(root).references.filter((reference) => reference.startsWith('credential:'));

    expect(references).toEqual([
      'credential:packages/example/src/credentials.ts#apiToken',
      'credential:packages/example/src/credentials.ts#clientCert',
      'credential:packages/example/src/credentials.ts#cookieStorage',
      'credential:packages/example/src/credentials.ts#sessionState',
    ]);
  });

  it('excludes tests, dist, and node_modules source trees', () => {
    const root = fixtureRoot();
    for (const path of [
      'packages/example/tests/TestLedger.ts',
      'dist/scripts/DistLedger.ts',
      'node_modules/example/DependencyLedger.ts',
    ]) writeSource(root, path, "import { writeFileSync } from 'node:fs'; export function persist() { writeFileSync('a', 'x'); }");

    const references = loadRepositoryCensus(root).references;

    expect(references.every((reference) => !/tests|dist|node_modules/u.test(reference))).toBe(true);
  });
});
