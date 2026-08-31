import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { analyzeSourceAst } from '../packages/sangfor-authority/src/repository-census-ast.js';
import { CREDENTIAL_REFS } from '../packages/sangfor-authority/src/migration-inventory-local.js';

const ROOT = join(import.meta.dirname, '..');
const ENTRY = 'scripts/test-browser-port.ts';
const LIB_DIRECTORY = 'scripts/lib';
const LIB_PREFIX = 'browser-port-qa-';
const MAX_PURE_LINES = 250;
const MIN_FAMILY_MODULES = 3;

/**
 * The census reads this symbol's own source text into the authority manifest
 * digest, so the split had to leave it declared in the entry script.
 */
const PINNED_CREDENTIAL_REF = 'credential:scripts/test-browser-port.ts#localReadBack';

const BROWSER_LAUNCH_MARKERS = [
  'playwright',
  'createPlaywrightJmBrowserDriver',
  'connectOverCDP',
] as const;

function libModulePaths(): readonly string[] {
  return readdirSync(join(ROOT, LIB_DIRECTORY))
    .filter((name) => name.startsWith(LIB_PREFIX) && name.endsWith('.ts'))
    .sort()
    .map((name) => `${LIB_DIRECTORY}/${name}`);
}

function pureLineCount(source: string): number {
  return source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed !== '' && !trimmed.startsWith('//') && !trimmed.startsWith('#');
    })
    .length;
}

function topLevelFunctionNames(relativePath: string): ReadonlySet<string> {
  const path = join(ROOT, relativePath);
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) names.add(statement.name.text);
  }
  return names;
}

describe('test-browser-port decomposition', () => {
  it('Given the browser-port QA family, When each module is measured, Then none exceeds the reviewable pure-line ceiling', () => {
    const oversized = [ENTRY, ...libModulePaths()]
      .map((relativePath) => ({
        name: basename(relativePath),
        lines: pureLineCount(readFileSync(join(ROOT, relativePath), 'utf8')),
      }))
      .filter(({ lines }) => lines > MAX_PURE_LINES);

    expect(oversized).toEqual([]);
  });

  it('Given the browser-port QA family, When its modules are enumerated, Then the entry is backed by focused sibling modules', () => {
    expect(libModulePaths().length).toBeGreaterThanOrEqual(MIN_FAMILY_MODULES);
  });

  it('Given the authority-pinned credential boundary, When the family is censused, Then it is the only boundary and it still lives in the entry script', () => {
    const family = [ENTRY, ...libModulePaths()].map((relativePath) => join(ROOT, relativePath));

    const census = analyzeSourceAst(ROOT, family);

    expect(census.credentialReferences).toEqual([PINNED_CREDENTIAL_REF]);
    expect(census.persistenceReferences).toEqual([]);
    expect(CREDENTIAL_REFS).toContain(PINNED_CREDENTIAL_REF);
    expect(topLevelFunctionNames(ENTRY)).toContain('localReadBack');
  });

  it.each(libModulePaths())('Given the focused module %s, When scanned, Then it carries no browser-launch dependency', (relativePath) => {
    const source = readFileSync(join(ROOT, relativePath), 'utf8');

    expect(BROWSER_LAUNCH_MARKERS.filter((marker) => source.includes(marker))).toEqual([]);
  });
});
