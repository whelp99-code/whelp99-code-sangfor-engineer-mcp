import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkRuntimeBoundaries } from '../scripts/check-runtime-boundaries.mjs';
const POLICIES = [
  ...Array.from({ length: 20 }, () => 'freeze'),
  ...Array.from({ length: 9 }, () => 'deny'),
  ...Array.from({ length: 9 }, () => 'loud_failure'),
  ...Array.from({ length: 6 }, () => 'invalid_report'),
  ...Array.from({ length: 5 }, () => 'INDETERMINATE'),
] as const;
const ENVIRONMENT_BOUNDARIES = [
  {
    id: 'FIXTURE_OBSERVER_ENV',
    environmentVariable: 'SANGFOR_OBSERVER_PROFILES_JSON',
    parser: 'decodeObserverRegistry',
    schemaName: 'fixture.observer-registry.v1',
  },
  {
    id: 'FIXTURE_CDP_ENV',
    environmentVariable: 'SANGFOR_JM_CDP_PROFILES_JSON',
    parser: 'decodeCdpRegistry',
    schemaName: 'fixture.cdp-registry.v1',
  },
] as const;
const reportSchema = z.object({
  status: z.enum(['pass', 'fail']),
  strictCalls: z.number(),
  unsafeAssertions: z.number(),
  environmentJson: z.number(),
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
  const calls = [
    ...POLICIES.map((_, index) => `${parserName(index)}(source);`),
    ...ENVIRONMENT_BOUNDARIES.map(({ environmentVariable, parser }) => (
      `${parser}(process.env.${environmentVariable});`
    )),
  ].join('\n');
  const parsers = [
    "const strictSchema = z.object({ value: z.string() }).strict();",
    ...POLICIES.map((_, index) => `export function ${parserName(index)}(source: string) { ${parserStatement(index)} }`),
    ...ENVIRONMENT_BOUNDARIES.map(({ parser, schemaName }) => (
      `export function ${parser}(source: string) { return parseRuntimeJson(source, { schema: strictSchema, schemaName: '${schemaName}', policy: 'deny' }); }`
    )),
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
  const environmentBoundaries = ENVIRONMENT_BOUNDARIES.map((boundary, index) => ({
    ...boundary,
    file: 'apps/runtime.ts',
    legacyLine: POLICIES.length + index + 1,
    owner: 'fixture-environment',
    legacySchema: 'FixtureEnvironment',
    schemaFile: 'packages/parsers.ts',
    policy: 'deny',
  }));
  writeFileSync(join(root, 'apps/runtime.ts'), `${calls}\n`);
  writeFileSync(join(root, 'packages/parsers.ts'), `${parsers}\n`);
  writeFileSync(
    join(root, 'scripts/runtime-boundaries.inventory.json'),
    JSON.stringify({ version: 2, boundaries, environmentBoundaries }),
  );
}

function replaceIn(path: string, before: string, after: string): void {
  const source = readFileSync(path, 'utf8');
  if (!source.includes(before)) throw new Error(`fixture mutation target missing: ${before}`);
  writeFileSync(path, source.replace(before, after));
}

function check(): { readonly code: number; readonly report: z.output<typeof reportSchema> } {
  const report = reportSchema.parse(checkRuntimeBoundaries({ root }));
  return {
    code: report.status === 'pass' ? 0 : 1,
    report,
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
  {
    name: 'unowned critical environment JSON without parser convention or cast',
    mutate: (dir) => writeFileSync(
      join(dir, 'apps/runtime.ts'),
      `${readFileSync(join(dir, 'apps/runtime.ts'), 'utf8')}decodeArbitrary(process.env['UNOWNED_CRITICAL_JSON']);\n`,
    ),
    violation: 'unowned critical environment JSON',
  },
  {
    name: 'inventoried environment JSON bypass without a cast',
    mutate: (dir) => replaceIn(
      join(dir, 'apps/runtime.ts'),
      'decodeObserverRegistry(process.env.SANGFOR_OBSERVER_PROFILES_JSON);',
      'JSON.parse(process.env.SANGFOR_OBSERVER_PROFILES_JSON);',
    ),
    violation: 'stale inventory entry has no decodeObserverRegistry call',
  },
  {
    name: 'environment inventory omission',
    mutate: (dir) => {
      const path = join(dir, 'scripts/runtime-boundaries.inventory.json');
      const schema = z.object({
        version: z.literal(2),
        boundaries: z.array(z.unknown()),
        environmentBoundaries: z.array(z.unknown()).min(1),
      }).strict();
      const inventory = schema.parse(JSON.parse(readFileSync(path, 'utf8')));
      writeFileSync(path, JSON.stringify({
        ...inventory,
        environmentBoundaries: inventory.environmentBoundaries.slice(1),
      }));
    },
    violation: 'environment boundary inventory: expected 2, found 1',
  },
];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'runtime-boundary-mutation-'));
  seedHarness();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('runtime boundary checker mutation gate', () => {
  it('Given a complete synthetic inventory, When checked, Then strict calls and environment JSON are owned', () => {
    // Given
    const expected = 49;

    // When
    const result = check();

    // Then
    expect(result.code).toBe(0);
    expect(result.report).toMatchObject({
      status: 'pass',
      strictCalls: expected,
      unsafeAssertions: 0,
      environmentJson: 2,
    });
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
