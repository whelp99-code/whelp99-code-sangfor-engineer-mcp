import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { AUTHORITY_MANIFEST } from '../packages/sangfor-authority/src/migration-manifest.js';
import { loadRepositoryCensus } from '../packages/sangfor-authority/src/repository-census.js';
import * as towerApi from '../apps/control-tower/src/api.js';
import { createApi } from '../apps/control-tower/src/api.js';

const ROOT = resolve(import.meta.dirname, '..');
const SRC = join(ROOT, 'apps/control-tower/src');
const SIZE_CEILING = 250;
const COMPOSITION_ROOT = 'api.ts';

/** Every module the tower REST API is composed from, composition root first. */
const TOWER_API_MODULES = [
  COMPOSITION_ROOT,
  'tower-contract.ts',
  'tower-authority-gate.ts',
  'tower-stores.ts',
  'run-summary.ts',
  'tower-bridge-runner.ts',
  'playbook-run-engine.ts',
  'tower-run-api.ts',
  'tower-approval-api.ts',
  'tower-device-api.ts',
  'tower-health-api.ts',
  'tower-playbook-api.ts',
  'tower-agent-task-api.ts',
] as const;

/** Names `server.ts`, `legacy-seed.ts`, and the suites import from `api.js`. */
const EXPECTED_DECLARED_EXPORTS = [
  'ApiError',
  'DeviceSummary',
  'HealthEntry',
  'HealthReport',
  'Overview',
  'TowerApi',
  'TowerOptions',
  'assertLocalApprovalAuthorityAllowed',
  'createApi',
  'summarize',
] as const;

const EXPECTED_RUNTIME_EXPORTS = [
  'ApiError',
  'assertLocalApprovalAuthorityAllowed',
  'createApi',
  'summarize',
] as const;

/** The REST surface `server.ts` routes onto. Losing one silently 404s a route. */
const EXPECTED_API_METHODS = [
  'addPlaybookRevision',
  'approveRun',
  'cancelAgentTask',
  'closeAgentTask',
  'continuePlaybookRun',
  'createAgentTask',
  'createDevice',
  'createPlaybook',
  'createRun',
  'deleteDevice',
  'executePlaybook',
  'getPlaybook',
  'getPlaybookRun',
  'getRun',
  'health',
  'listAgentTasks',
  'listDevices',
  'listPlaybooks',
  'listRuns',
  'mint',
  'overview',
  'rejectRun',
  'reviewPlaybookRevision',
  'seedPlaybooks',
  'setAnalysisVerdict',
  'submitAnalysis',
  'sweep',
  'toolGroups',
  'updateDevice',
] as const;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function moduleSource(name: string): string {
  const path = join(SRC, name);
  // A missing module is reported by the size census; the other checks must still assert.
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function pureLineCount(source: string): number {
  return source.split('\n')
    .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('//'))
    .length;
}

function parseModule(name: string): ts.SourceFile {
  return ts.createSourceFile(join(SRC, name), moduleSource(name), ts.ScriptTarget.Latest, true);
}

function declarationName(statement: ts.Statement): string | undefined {
  if (ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement)) return statement.name?.text;
  if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) return statement.name.text;
  return undefined;
}

/** Exported names of a module, counting own declarations and `export ... from` re-exports alike. */
function declaredExports(name: string): readonly string[] {
  const source = parseModule(name);
  const names: string[] = [];
  for (const statement of source.statements) {
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    const exported = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
    if (exported) {
      const declared = declarationName(statement);
      if (declared !== undefined) names.push(declared);
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
        }
      }
    }
    if (ts.isExportDeclaration(statement) && statement.exportClause !== undefined
      && ts.isNamedExports(statement.exportClause)) {
      names.push(...statement.exportClause.elements.map((element) => element.name.text));
    }
  }
  return [...new Set(names)].sort();
}

/** Relative module specifiers a module imports, for example `./tower-stores.js`. */
function localImports(name: string): readonly string[] {
  const source = parseModule(name);
  const specifiers: string[] = [];
  for (const statement of source.statements) {
    if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
      && statement.moduleSpecifier !== undefined
      && ts.isStringLiteral(statement.moduleSpecifier)
      && statement.moduleSpecifier.text.startsWith('./')) {
      specifiers.push(statement.moduleSpecifier.text);
    }
  }
  return specifiers;
}

/** Authority refs the canonical manifest pins to the control-tower app. */
function pinnedTowerRefs(): readonly string[] {
  const pinned = AUTHORITY_MANIFEST.entries
    .flatMap((entry) => entry.inventoryRefs)
    .filter((reference) => reference.includes('apps/control-tower/'));
  return [...new Set(pinned)].sort();
}

describe('control-tower API module decomposition', () => {
  it('keeps every composed tower API module below the source-module size ceiling', () => {
    // Given the module set the tower REST API is composed from.
    const measured = TOWER_API_MODULES.map((name) => {
      const path = join(SRC, name);
      return [name, existsSync(path) ? pureLineCount(readFileSync(path, 'utf8')) : Number.POSITIVE_INFINITY] as const;
    });

    // When pure source lines are counted without blank or line-comment-only lines.
    const oversized = measured.filter(([, lines]) => lines >= SIZE_CEILING).map(([name]) => name);

    // Then every module stays inside a single reviewer's working memory, and none is missing.
    expect(oversized).toEqual([]);
  });

  it('preserves the declared and runtime export surface of the composition root', () => {
    // Given the names every importer of `api.js` binds.
    // When the module's static declarations and runtime keys are inspected.
    const declared = declaredExports(COMPOSITION_ROOT);
    const runtime = Object.keys(towerApi).sort();

    // Then type-only and runtime consumers keep exactly the same names.
    expect(declared).toEqual([...EXPECTED_DECLARED_EXPORTS].sort());
    expect(runtime).toEqual([...EXPECTED_RUNTIME_EXPORTS].sort());
  });

  it('assembles the whole REST surface from the composed modules', () => {
    // Given a tower composed over throwaway local roots.
    const root = mkdtempSync(join(tmpdir(), 'tower-api-census-'));
    roots.push(root);
    const api = createApi({
      authorityMode: 'local',
      runsDir: join(root, 'runs'),
      registryDir: join(root, 'registry'),
      playbookOutputDir: join(root, 'reports'),
      approvalSecret: 'census-secret',
    });

    // When the assembled surface is enumerated.
    const methods = Object.keys(api).sort();

    // Then every route `server.ts` dispatches to is present, callable, and nothing extra is.
    expect(methods).toEqual([...EXPECTED_API_METHODS].sort());
    expect(methods.filter((name) => typeof api[name as keyof typeof api] !== 'function')).toEqual([]);
  });

  it('composes the tower surface in one direction only, from the root outwards', () => {
    // Given the extracted modules, excluding the composition root itself.
    const extracted = TOWER_API_MODULES.filter((name) => name !== COMPOSITION_ROOT);

    // When their relative imports are read off the syntax tree.
    const importingTheRoot = extracted.filter((name) => localImports(name).includes(`./${COMPOSITION_ROOT.replace(/\.ts$/u, '.js')}`));
    const rootImports = localImports(COMPOSITION_ROOT);
    const uncomposed = extracted.filter((name) => !rootImports.includes(`./${name.replace(/\.ts$/u, '.js')}`));

    // Then no extracted module imports the root back, and the root composes them all.
    expect(importingTheRoot).toEqual([]);
    expect(uncomposed).toEqual([]);
  });

  it('keeps every authority-pinned tower owner attributed to its inventoried module', () => {
    // Given the persistence and credential refs the canonical manifest pins to this app.
    const pinned = pinnedTowerRefs();
    expect(pinned.length).toBeGreaterThan(0);

    // When the repository census re-derives ownership from the current source tree.
    const discovered = loadRepositoryCensus(ROOT).references
      .filter((reference) => reference.includes('apps/control-tower/'));

    // Then the split moved no writer or credential boundary to an uninventoried module.
    expect([...discovered].sort()).toEqual(pinned);
  }, 60_000);
});
