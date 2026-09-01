import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const TESTS_DIR = fileURLToPath(new URL('.', import.meta.url));
const FAMILY_PREFIX = 'learning-registry-version';
const MAX_PURE_LINES = 250;
const MIN_FAMILY_MODULES = 2;
// Case count of the pre-split learning-registry-version monolith — parity lock.
const EXPECTED_FAMILY_CASE_COUNT = 10;

function pureLineCount(source: string): number {
  return source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed !== '' && !trimmed.startsWith('//') && !trimmed.startsWith('#');
    })
    .length;
}

function caseCount(source: string): number {
  return source.split('\n').filter((line) => /^\s*it\(/.test(line)).length;
}

function familyModules(): readonly string[] {
  return readdirSync(TESTS_DIR)
    .filter((name) => name.startsWith(FAMILY_PREFIX) && name.endsWith('.test.ts'))
    .sort();
}

function readFamily(): readonly { readonly name: string; readonly source: string }[] {
  return familyModules().map((name) => ({ name, source: readFileSync(join(TESTS_DIR, name), 'utf8') }));
}

describe('Learning registry/version test decomposition', () => {
  it('keeps every learning-registry-version test module within the reviewable pure-line limit', () => {
    const oversized = readFamily().flatMap(({ name, source }) => {
      const lines = pureLineCount(source);
      return lines > MAX_PURE_LINES ? [`${name}:${lines}`] : [];
    });

    expect(oversized).toEqual([]);
  });

  it('spreads the family across sibling modules instead of a single monolith', () => {
    expect(familyModules().length).toBeGreaterThanOrEqual(MIN_FAMILY_MODULES);
  });

  it('preserves the monolith case count across the decomposed modules', () => {
    const perModule = readFamily().map(({ name, source }) => [name, caseCount(source)] as const);
    const total = perModule.reduce((sum, [, count]) => sum + count, 0);

    expect(perModule.filter(([, count]) => count === 0)).toEqual([]);
    expect(total).toBe(EXPECTED_FAMILY_CASE_COUNT);
  });

  it('declares no skipped, exclusive, or todo cases in the family', () => {
    const weakened = readFamily().flatMap(({ name, source }) =>
      source
        .split('\n')
        .flatMap((line, index) => /\b(?:it|test|describe)\.(?:skip|only|todo|skipIf|runIf)\b/.test(line)
          ? [`${name}:${index + 1}`]
          : []));

    expect(weakened).toEqual([]);
  });
});
