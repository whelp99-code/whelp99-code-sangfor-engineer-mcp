import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const TESTS_DIR = import.meta.dirname;
const PURE_LOC_CEILING = 250;
const FAMILIES = [
  { prefix: 'console-evidence-capture', modules: 2, cases: 19 },
  { prefix: 'blro-enrollment-postgres', modules: 2, cases: 12 },
  { prefix: 'blro-restore-drill-postgres', modules: 3, cases: 14 },
  { prefix: 'nonce-gate-wiring', modules: 2, cases: 13 },
] as const;
const WEAKENED_CASE = /\b(?:it|test)\.(?:skip|only|todo|skipIf|runIf|fails|concurrent)\b/u;

type TestCaseCensus = {
  readonly count: number;
  readonly title: string | null;
  readonly hasAssertion: boolean;
};

function familyFiles(prefix: string): readonly string[] {
  return readdirSync(TESTS_DIR)
    .filter((name) => name.startsWith(prefix) && /\.(?:suite|test)\.ts$/u.test(name))
    .sort();
}

function pureLoc(source: string): number {
  return source.split('\n').filter((line) => {
    const trimmed = line.trim();
    return trimmed !== '' && !trimmed.startsWith('//') && !trimmed.startsWith('#');
  }).length;
}

function containsExpect(node: ts.Node): boolean {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'expect') return true;
  return node.getChildren().some(containsExpect);
}

function testCaseCensus(file: string): readonly TestCaseCensus[] {
  const source = readFileSync(join(TESTS_DIR, file), 'utf8');
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const cases: TestCaseCensus[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const direct = ts.isIdentifier(node.expression) && node.expression.text === 'it';
      const each = ts.isCallExpression(node.expression)
        && ts.isPropertyAccessExpression(node.expression.expression)
        && ts.isIdentifier(node.expression.expression.expression)
        && node.expression.expression.expression.text === 'it'
        && node.expression.expression.name.text === 'each';
      if (direct || each) {
        const title = node.arguments[0];
        const callback = node.arguments[1];
        const rows = each ? node.expression.arguments[0] : undefined;
        const rowArray = rows !== undefined && ts.isAsExpression(rows) ? rows.expression : rows;
        cases.push({
          count: rowArray !== undefined && ts.isArrayLiteralExpression(rowArray) ? rowArray.elements.length : 1,
          title: title !== undefined && ts.isStringLiteral(title) ? title.text : null,
          hasAssertion: callback !== undefined && containsExpect(callback),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return cases;
}

describe('production-readiness test decomposition census', () => {
  it('Given the four split families, When their modules are measured, Then every file stays below 250 pure LOC', () => {
    const oversized = FAMILIES.flatMap(({ prefix }) => familyFiles(prefix).flatMap((file) => {
      const lines = pureLoc(readFileSync(join(TESTS_DIR, file), 'utf8'));
      return lines >= PURE_LOC_CEILING ? [`${file}:${String(lines)}`] : [];
    }));
    expect(oversized).toEqual([]);
  });

  it('Given the pre-split census, When sibling modules are enumerated, Then every family and runtime case remains present', () => {
    const census = FAMILIES.map(({ prefix, modules, cases }) => {
      const files = familyFiles(prefix);
      const actualCases = files.flatMap(testCaseCensus).reduce((total, item) => total + item.count, 0);
      return { prefix, modules: files.length, expectedModules: modules, cases: actualCases, expectedCases: cases };
    });
    expect(census).toEqual(FAMILIES.map(({ prefix, modules, cases }) => ({
      prefix, modules, expectedModules: modules, cases, expectedCases: cases,
    })));
  });

  it('Given every preserved case, When the AST census reads it, Then its title and assertion remain machine-visible', () => {
    const mutated = FAMILIES.flatMap(({ prefix }) => familyFiles(prefix).flatMap((file) =>
      testCaseCensus(file).flatMap((testCase, index) =>
        testCase.title === null || !testCase.hasAssertion ? [`${file}#${String(index + 1)}`] : [])));
    expect(mutated).toEqual([]);
  });

  it('Given every split family, When mutation gates are scanned, Then no case is skipped, focused, or made todo', () => {
    const weakened = FAMILIES.flatMap(({ prefix }) => familyFiles(prefix).flatMap((file) =>
      readFileSync(join(TESTS_DIR, file), 'utf8').split('\n').flatMap((line, index) =>
        WEAKENED_CASE.test(line) ? [`${file}:${String(index + 1)}`] : [])));
    expect(weakened).toEqual([]);
  });
});
