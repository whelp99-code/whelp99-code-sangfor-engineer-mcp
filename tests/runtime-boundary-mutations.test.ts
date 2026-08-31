import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const CHECKER = join(process.cwd(), 'scripts/check-runtime-boundaries.mjs');
const POLICIES = [
  ...Array.from({ length: 20 }, () => 'freeze'),
  ...Array.from({ length: 9 }, () => 'deny'),
  ...Array.from({ length: 9 }, () => 'loud_failure'),
  ...Array.from({ length: 6 }, () => 'invalid_report'),
  ...Array.from({ length: 5 }, () => 'INDETERMINATE'),
] as const;
const reportSchema = z.object({
  status: z.enum(['pass', 'fail']),
  strictCalls: z.number(),
  unsafeAssertions: z.number(),
  stale: z.number(),
  duplicate: z.number(),
  unowned: z.number(),
  violations: z.array(z.string()).optional(),
}).strip();

type HarnessMutation = {
  readonly name: string;
  readonly mutate: (root: string) => void;
  readonly violation: string;
};

let root: string;

function parserName(index: number): string {
  return `parseBoundaryFixture${String(index)}V1`;
}

function parserStatement(index: number): string {
  return `return parseRuntimeJson(source, { schema: strictSchema, schemaName: 'fixture.${String(index)}.v1', policy: '${POLICIES[index]}' });`;
}

function seedHarness(): void {
  mkdirSync(join(root, 'apps'), { recursive: true });
  mkdirSync(join(root, 'packages'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  const calls = POLICIES.map((_, index) => `${parserName(index)}(source);`).join('\n');
  const parsers = [
    "const strictSchema = z.object({ value: z.string() }).strict();",
    ...POLICIES.map((_, index) => `export function ${parserName(index)}(source: string) { ${parserStatement(index)} }`),
  ].join('\n');
  const boundaries = POLICIES.map((policy, index) => ({
    id: `FIXTURE_${String(index)}`,
    file: 'apps/runtime.ts',
    legacyLine: index + 1,
    owner: 'fixture',
    legacySchema: 'Fixture',
    parser: parserName(index),
    schemaFile: 'packages/parsers.ts',
    schemaName: `fixture.${String(index)}.v1`,
    policy,
  }));
  writeFileSync(join(root, 'apps/runtime.ts'), `${calls}\n`);
  writeFileSync(join(root, 'packages/parsers.ts'), `${parsers}\n`);
  writeFileSync(join(root, 'scripts/runtime-boundaries.inventory.json'), JSON.stringify({ version: 2, boundaries }));
}

function replaceIn(path: string, before: string, after: string): void {
  const source = readFileSync(path, 'utf8');
  if (!source.includes(before)) throw new Error(`fixture mutation target missing: ${before}`);
  writeFileSync(path, source.replace(before, after));
}

function check(): { readonly code: number; readonly report: z.output<typeof reportSchema> } {
  const result = spawnSync(process.execPath, [CHECKER, '--root', root, '--json'], { encoding: 'utf8' });
  return {
    code: result.status ?? -1,
    report: reportSchema.parse(JSON.parse(result.stdout)),
  };
}

const mutations: readonly HarnessMutation[] = [
  {
    name: 'parser bypass',
    mutate: (dir) => replaceIn(
      join(dir, 'packages/parsers.ts'),
      parserStatement(0),
      parserStatement(0).replace('parseRuntimeJson', 'unsafeDecode'),
    ),
    violation: 'bypasses shared runtime protections',
  },
  {
    name: 'passthrough schema',
    mutate: (dir) => writeFileSync(
      join(dir, 'packages/parsers.ts'),
      `${readFileSync(join(dir, 'packages/parsers.ts'), 'utf8')}\nconst permissive = z.object({}).passthrough();\n`,
    ),
    violation: 'permissive passthrough',
  },
  {
    name: 'empty reset fallback',
    mutate: (dir) => replaceIn(join(dir, 'packages/parsers.ts'), parserStatement(0), 'return [];'),
    violation: 'resets rejected input to empty state',
  },
  {
    name: 'swallowed error',
    mutate: (dir) => replaceIn(
      join(dir, 'packages/parsers.ts'),
      parserStatement(0),
      `try { ${parserStatement(0)} } catch { return {}; }`,
    ),
    violation: 'catches or swallows',
  },
  {
    name: 'policy swap',
    mutate: (dir) => replaceIn(
      join(dir, 'packages/parsers.ts'),
      parserStatement(0),
      parserStatement(0).replace("policy: 'freeze'", "policy: 'deny'"),
    ),
    violation: 'policy does not match inventory',
  },
  {
    name: 'unsafe call bypass',
    mutate: (dir) => replaceIn(
      join(dir, 'apps/runtime.ts'),
      `${parserName(0)}(source);`,
      'JSON.parse(source) as Record<string, unknown>;',
    ),
    violation: 'unsafe JSON.parse assertion remains',
  },
  {
    name: 'unowned boundary',
    mutate: (dir) => writeFileSync(
      join(dir, 'apps/runtime.ts'),
      `${readFileSync(join(dir, 'apps/runtime.ts'), 'utf8')}parseBoundaryUnownedV1(source);\n`,
    ),
    violation: 'unowned strict parser call',
  },
];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'runtime-boundary-mutation-'));
  seedHarness();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('runtime boundary checker mutation gate', () => {
  it('Given a complete synthetic inventory, When checked, Then all 49 strict calls are owned', () => {
    // Given
    const expected = 49;

    // When
    const result = check();

    // Then
    expect(result.code).toBe(0);
    expect(result.report).toMatchObject({ status: 'pass', strictCalls: expected, unsafeAssertions: 0 });
  });

  it.each(mutations)('Given the $name mutant, When checked, Then the gate kills it', (mutation) => {
    // Given
    mutation.mutate(root);

    // When
    const result = check();

    // Then
    expect(result.code).not.toBe(0);
    expect(result.report.status).toBe('fail');
    expect(result.report.violations?.join('\n')).toContain(mutation.violation);
  });
});
