import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const TEST_ROOT = join(process.cwd(), 'tests');
const PURE_LOC_CEILING = 249;
const EXPECTED_TESTS = 120;
const EXPECTED_ASSERTIONS = 342;
const FAMILY_FILES = [
  'jm-browser-agent-tls-integration.test.ts',
  'jm-browser-agent-drain.test.ts',
  'jm-browser-agent-startup.test.ts',
  'jm-browser-agent-certificate.test.ts',
  'approval-primitives.test.ts',
  'learning-approval-adapter.test.ts',
  'blro-restore-policy.test.ts',
  'blro-restore-equality.test.ts',
  'blro-restore-target-cli.test.ts',
  'blro-restore-durability.test.ts',
  'control-tower-api.test.ts',
  'control-tower-operations-api.test.ts',
  'control-tower-concurrency-ui.test.ts',
] as const;

type Census = {
  readonly tests: number;
  readonly assertions: number;
  readonly oversized: readonly string[];
};

function census(sources: Readonly<Record<string, string>>): Census {
  let tests = 0;
  let assertions = 0;
  const oversized: string[] = [];
  for (const [name, source] of Object.entries(sources)) {
    tests += [...source.matchAll(/^\s*(?:it|test)(?:\.each\([^\n]*\))?\s*\(/gmu)].length;
    assertions += [...source.matchAll(/\bexpect\s*\(/gu)].length;
    const pureLoc = source.split('\n')
      .filter((line) => line.trim().length > 0 && !/^\s*(?:\/\/|#|--)/u.test(line))
      .length;
    if (pureLoc > PURE_LOC_CEILING) oversized.push(`${name}:${String(pureLoc)}`);
  }
  return { tests, assertions, oversized };
}

function familySources(): Record<string, string> {
  return Object.fromEntries(FAMILY_FILES.map((name) => [name, readFileSync(join(TEST_ROOT, name), 'utf8')]));
}

describe('production-readiness test split census', () => {
  it('Given the split family, When censused, Then every original case remains in a reviewable file', () => {
    const result = census(familySources());

    expect(result.tests).toBe(EXPECTED_TESTS);
    expect(result.assertions).toBe(EXPECTED_ASSERTIONS);
    expect(result.oversized).toEqual([]);
  });

  it.each([
    {
      name: 'one test declaration is removed',
      mutate: (sources: Record<string, string>) => {
        const name = FAMILY_FILES[0];
        sources[name] = sources[name].replace(/^(\s*)it\(/mu, '$1void(');
      },
    },
    {
      name: 'one assertion is removed',
      mutate: (sources: Record<string, string>) => {
        const name = FAMILY_FILES[0];
        sources[name] = sources[name].replace(/\bexpect\s*\(/u, 'void(');
      },
    },
    {
      name: 'one suite grows beyond the pure LOC ceiling',
      mutate: (sources: Record<string, string>) => {
        const name = FAMILY_FILES[0];
        sources[name] += `\n${'void 0;\n'.repeat(PURE_LOC_CEILING)}`;
      },
    },
  ])('Given $name, When censused, Then the structural gate kills the mutant', ({ mutate }) => {
    const sources = familySources();
    mutate(sources);

    const result = census(sources);

    expect(
      result.tests === EXPECTED_TESTS
      && result.assertions === EXPECTED_ASSERTIONS
      && result.oversized.length === 0,
    ).toBe(false);
  });
});
