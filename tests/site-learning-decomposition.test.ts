import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const TESTS_DIR = fileURLToPath(new URL('.', import.meta.url));
const FAMILY_PREFIX = 'site-learning-crawler';
const MAX_PURE_LINES = 250;
const MIN_FAMILY_MODULES = 2;
// Case count of the pre-split site-learning-crawler monolith — parity lock.
const EXPECTED_FAMILY_CASE_COUNT = 24;

const CASE_LINE = /^\s*it\(/;
const CASE_TITLE = /^\s*it\(\s*'([^']+)'/;
const WEAKENED_CASE = /\b(?:it|test|describe)\.(?:skip|only|todo|skipIf|runIf|fails|concurrent)\b/;

interface FamilyModule {
  readonly name: string;
  readonly source: string;
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

/**
 * One entry per declared case, in file order. `null` marks an `it(` the census could
 * not read a title from — without this the duplicate check would silently under-count.
 */
function declaredCases(source: string): readonly (string | null)[] {
  return source
    .split('\n')
    .filter((line) => CASE_LINE.test(line))
    .map((line) => CASE_TITLE.exec(line)?.[1] ?? null);
}

function familyModuleNames(): readonly string[] {
  return readdirSync(TESTS_DIR)
    .filter((name) => name.startsWith(FAMILY_PREFIX) && name.endsWith('.test.ts'))
    .sort();
}

function readFamily(): readonly FamilyModule[] {
  return familyModuleNames().map((name) => ({ name, source: readFileSync(join(TESTS_DIR, name), 'utf8') }));
}

describe('site-learning-crawler test decomposition', () => {
  it('Given every site-learning-crawler test module, When measured, Then each stays within the reviewable pure-line limit', () => {
    const oversized = readFamily().flatMap(({ name, source }) => {
      const lines = pureLineCount(source);
      return lines > MAX_PURE_LINES ? [`${name}:${String(lines)}`] : [];
    });

    expect(oversized).toEqual([]);
  });

  it('Given the crawler suite, When its modules are enumerated, Then the family spans sibling modules instead of a single monolith', () => {
    expect(familyModuleNames().length).toBeGreaterThanOrEqual(MIN_FAMILY_MODULES);
  });

  it('Given the decomposed family, When its cases are counted, Then every module carries cases and the monolith total is preserved', () => {
    const perModule = readFamily().map(({ name, source }) => [name, declaredCases(source).length] as const);
    const total = perModule.reduce((sum, [, count]) => sum + count, 0);

    expect(perModule.filter(([, count]) => count === 0)).toEqual([]);
    expect(total).toBe(EXPECTED_FAMILY_CASE_COUNT);
  });

  it('Given the decomposed family, When case titles are collected, Then no title is declared twice across the modules', () => {
    const seen = new Map<string, string[]>();
    for (const { name, source } of readFamily()) {
      for (const title of declaredCases(source)) {
        if (title === null) continue;
        seen.set(title, [...(seen.get(title) ?? []), name]);
      }
    }
    const duplicated = [...seen.entries()]
      .filter(([, owners]) => owners.length > 1)
      .map(([title, owners]) => `${title} -> ${owners.join(', ')}`)
      .sort();

    expect(duplicated).toEqual([]);
  });

  it('Given the decomposed family, When each declared case is read, Then the census can account for every case title', () => {
    const unreadable = readFamily().flatMap(({ name, source }) =>
      declaredCases(source).flatMap((title, index) => (title === null ? [`${name}#${String(index + 1)}`] : [])));

    expect(unreadable).toEqual([]);
  });

  it('Given the decomposed family, When scanned for gates, Then no case is skipped, exclusive, or todo', () => {
    const weakened = readFamily().flatMap(({ name, source }) =>
      source
        .split('\n')
        .flatMap((line, index) => (WEAKENED_CASE.test(line) ? [`${name}:${String(index + 1)}`] : [])));

    expect(weakened).toEqual([]);
  });
});
