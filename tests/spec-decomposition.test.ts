import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as specBarrel from '../packages/sangfor-spec/src/index.js';
import {
  evaluateSpec,
  type Category,
  type Citation,
  type CompareOp,
  type CoverageInfo,
  type EvaluateOptions,
  type EvaluationResult,
  type EvaluationSummary,
  type IntendedSpec,
  type ItemResult,
  type ObservedFact,
  type ObservedSource,
  type ProductCode,
  type Severity,
  type SpecItem,
  type Verdict,
} from '../packages/sangfor-spec/src/index.js';

const ROOT = join(import.meta.dirname, '..');
const SOURCE_DIR = join(ROOT, 'packages', 'sangfor-spec', 'src');
const BARREL = join(SOURCE_DIR, 'index.ts');
const PURE_LOC_CEILING = 250;
const BARREL_LOC_CEILING = 40;
const MIN_FOCUSED_MODULES = 5;

/** The public surface every downstream consumer (mcp-server, operator-console,
 *  intent-graph, diagnose scripts) imports from the barrel. */
const PUBLIC_RUNTIME_EXPORTS = [
  'evaluateSpec',
  'listSpecCoverage',
  'loadSpec',
  'normalizeSpecProduct',
  'renderAdvisoryReport',
  'renderAdvisoryReportDocx',
] as const;

/** A barrel re-exports; it does not declare. Anything matching these at line start
 *  means implementation leaked back into the entry module. */
const DECLARATION_PATTERNS: readonly RegExp[] = [
  /^export\s+(?:async\s+)?function\s/u,
  /^export\s+interface\s/u,
  /^export\s+(?:const|let|var)\s/u,
  /^export\s+type\s+[A-Za-z_$][\w$]*\s*=/u,
  /^(?:async\s+)?function\s/u,
  /^interface\s/u,
  /^(?:const|let|var)\s/u,
  /^class\s/u,
];

function pureLoc(path: string): number {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !trimmed.startsWith('//') && !trimmed.startsWith('#');
    })
    .length;
}

function sourceModules(): string[] {
  return readdirSync(SOURCE_DIR)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join(SOURCE_DIR, name));
}

describe('sangfor spec decomposition', () => {
  it('Given every spec source module, When measured, Then each stays within 250 pure LOC', () => {
    // Given
    const modules = sourceModules();

    // When
    const oversized = modules
      .map((path) => ({ name: basename(path), lines: pureLoc(path) }))
      .filter(({ lines }) => lines > PURE_LOC_CEILING);

    // Then
    expect(oversized).toEqual([]);
  });

  it('Given the spec entry module, When inspected, Then it is a thin barrel with no declarations', () => {
    // Given
    const lines = readFileSync(BARREL, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('//'));

    // When
    const declarations = lines.filter((line) => DECLARATION_PATTERNS.some((pattern) => pattern.test(line)));

    // Then
    expect(declarations).toEqual([]);
    expect(pureLoc(BARREL)).toBeLessThanOrEqual(BARREL_LOC_CEILING);
  });

  it('Given the decomposed package, When its modules are listed, Then focused modules carry the implementation', () => {
    // Given
    const modules = sourceModules().map((path) => basename(path));

    // When
    const focused = modules.filter((name) => name !== 'index.ts');

    // Then
    expect(focused.length).toBeGreaterThanOrEqual(MIN_FOCUSED_MODULES);
  });

  it('Given the barrel, When its runtime exports are enumerated, Then the public surface is unchanged', () => {
    // Given
    const expected = [...PUBLIC_RUNTIME_EXPORTS].sort();

    // When
    const actual = Object.keys(specBarrel).sort();

    // Then
    expect(actual).toEqual(expected);
  });

  it('Given the full public type surface, When a fresh cited spec is evaluated, Then provenance and PASS survive the barrel', () => {
    // Given
    const op: CompareOp = 'gte';
    const severity: Severity = 'must';
    const product: ProductCode = 'IAG';
    const citation: Citation = { manual: 'IAG Admin Guide', section: '5.2', page: 'p.41' };
    const item: SpecItem = {
      id: 'item.log-retention',
      capabilityId: 'cap.logging',
      label: '로그 보존 기간',
      observedKey: 'logRetentionDays',
      op,
      expected: 180,
      severity,
      source: citation,
      maxAgeSec: 3600,
    };
    const spec: IntendedSpec = { id: 'spec.iag', product, version: '13.0.120', items: [item] };
    const observedSource: ObservedSource = {
      endpoint: 'GET /api/log/config',
      collectedAt: '2026-01-01T00:00:00.000Z',
      collector: 'live-xhr',
    };
    const fact: ObservedFact = { value: 365, source: observedSource };
    const options: EvaluateOptions = { now: '2026-01-01T00:10:00.000Z' };

    // When
    const result: EvaluationResult = evaluateSpec(spec, { logRetentionDays: fact }, options);

    // Then
    const items: readonly ItemResult[] = result.items;
    const [first] = items;
    const expectedVerdict: Verdict = 'PASS';
    const expectedCategory: Category = 'ok';
    const summary: EvaluationSummary = result.summary;
    const coverage: CoverageInfo = result.coverage;
    expect(first?.verdict).toBe(expectedVerdict);
    expect(first?.category).toBe(expectedCategory);
    expect(first?.observedSource).toEqual(observedSource);
    expect(summary.pass).toBe(1);
    expect(summary.indeterminate).toBe(0);
    expect(coverage.specifiedTotal).toBe(1);
    expect(coverage.unobservedItems).toEqual([]);
    expect(result.ok).toBe(true);
  });
});
