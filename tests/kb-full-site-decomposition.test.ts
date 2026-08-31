import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const ENTRY = join(ROOT, 'scripts', 'learn-kb-full-site.ts');
const IMPLEMENTATION_MODULE_PREFIX = 'kb-full-site-';

function pureLoc(path: string): number {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !trimmed.startsWith('//') && !trimmed.startsWith('#');
    })
    .length;
}

describe('learn-kb-full-site decomposition', () => {
  it('keeps the entry and each focused implementation module within the pure LOC ceiling', () => {
    // Given the full-site entry and its focused implementation modules
    const modules = readdirSync(join(ROOT, 'scripts', 'lib'))
      .filter((name) => name.startsWith(IMPLEMENTATION_MODULE_PREFIX) && name.endsWith('.ts'))
      .map((name) => join(ROOT, 'scripts', 'lib', name));

    // When their pure source sizes are measured
    const oversized = [ENTRY, ...modules]
      .map((path) => ({ name: basename(path), lines: pureLoc(path) }))
      .filter(({ lines }) => lines > 250);

    // Then no composition or focused module exceeds the architectural ceiling
    expect(oversized).toEqual([]);
  });
});
