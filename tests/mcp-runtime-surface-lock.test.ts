import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { captureMcpRuntimeSurface } from './helpers/mcp-runtime-surface-driver.js';

const ROOT = resolve(import.meta.dirname, '..');
const BASELINE_PATH = join(ROOT, 'tests/fixtures/mcp-runtime-baseline-v1.json');
const DELTA_PATH = join(ROOT, 'tests/fixtures/mcp-iag-surface-delta-v1.json');
const IAG_ADDITIONS = [
  'sangfor_iag_exception_apply',
  'sangfor_iag_exception_dry_run',
  'sangfor_iag_exception_status',
] as const;

const toolSchema = z.object({
  name: z.string(),
  category: z.string(),
  inputSchema: z.record(z.unknown()),
  annotations: z.object({ readOnlyHint: z.boolean(), destructiveHint: z.boolean() }),
});
const baselineSchema = z.object({
  schemaVersion: z.literal('mcp-runtime-baseline.v1'),
  source: z.object({ ref: z.literal('origin/main'), commit: z.string().regex(/^[a-f0-9]{40}$/u) }),
  toolCount: z.literal(115),
  initialize: z.unknown(),
  tools: z.array(toolSchema),
  resources: z.array(z.object({ uri: z.string(), mimeType: z.string() })),
  prompts: z.array(z.object({
    name: z.string(),
    arguments: z.array(z.object({ name: z.string(), required: z.boolean() })),
  })),
  representative: z.object({ products: z.unknown(), scopedRag: z.unknown(), dryRun: z.unknown(), resourceRead: z.unknown() }),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
const deltaSchema = z.object({
  schemaVersion: z.literal('mcp-iag-surface-delta.v1'),
  baselineCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  baselineToolCount: z.literal(115),
  finalToolCount: z.literal(118),
  approvedAdditions: z.array(toolSchema).length(3),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
type Tool = z.infer<typeof toolSchema>;
type Baseline = z.infer<typeof baselineSchema>;
type Delta = z.infer<typeof deltaSchema>;

function fixtureDigest(value: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function stripProse(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripProse);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => key !== 'description' && key !== 'title')
      .map(([key, child]) => [key, stripProse(child)]));
  }
  return value;
}

function descriptor(value: unknown): Tool {
  return toolSchema.parse(stripProse(value));
}

function assertReviewedSurface(tools: readonly Tool[], baseline: Baseline, delta: Delta): void {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const expectedNames = [...baseline.tools.map(({ name }) => name), ...IAG_ADDITIONS].sort();
  expect(tools.map(({ name }) => name).sort()).toEqual(expectedNames);
  expect(new Set(expectedNames).size).toBe(delta.finalToolCount);
  for (const expected of baseline.tools) expect(byName.get(expected.name), expected.name).toEqual(expected);
  expect(delta.approvedAdditions.map(({ name }) => name).sort()).toEqual([...IAG_ADDITIONS]);
  for (const expected of delta.approvedAdditions) expect(byName.get(expected.name), expected.name).toEqual(expected);
}

function pureLoc(path: string): number {
  return readFileSync(path, 'utf8').split('\n').filter((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith('//');
  }).length;
}

const baseline = baselineSchema.parse(JSON.parse(readFileSync(BASELINE_PATH, 'utf8')));
const delta = deltaSchema.parse(JSON.parse(readFileSync(DELTA_PATH, 'utf8')));
let captured: Awaited<ReturnType<typeof captureMcpRuntimeSurface>>;

beforeAll(async () => {
  captured = await captureMcpRuntimeSurface(ROOT);
}, 60_000);

describe('MCP runtime baseline and reviewed IAG delta', () => {
  it('preserves all 115 baseline schemas and adds only the three approved IAG tools', () => {
    const actual = z.object({
      initialize: z.unknown(),
      tools: z.array(z.unknown()),
      resources: z.object({ resources: z.array(z.object({ uri: z.string(), mimeType: z.string() }).passthrough()) }),
      prompts: z.object({ prompts: z.array(z.object({
        name: z.string(),
        arguments: z.array(z.object({ name: z.string(), required: z.boolean() }).passthrough()).optional(),
      }).passthrough()) }),
      representative: z.object({
        products: z.object({ structuredContent: z.object({ products: z.array(z.object({ code: z.string(), priority: z.number() }).passthrough()) }) }),
        scopedRag: z.object({ structuredContent: z.unknown() }),
        dryRun: z.object({ structuredContent: z.unknown() }),
        resourceRead: z.object({ contents: z.array(z.object({ text: z.string() })).length(1) }),
      }),
      qa: z.object({ generatedFiles: z.array(z.string()), secretValuesAbsent: z.boolean(), stderr: z.array(z.string()) }),
    }).parse(captured);
    const tools = actual.tools.map(descriptor);

    assertReviewedSurface(tools, baseline, delta);
    expect(actual.initialize).toEqual(baseline.initialize);
    expect(actual.resources.resources.map(({ uri, mimeType }) => ({ uri, mimeType }))).toEqual(baseline.resources);
    expect(actual.prompts.prompts.map(({ name, arguments: args = [] }) => ({
      name, arguments: args.map(({ name: argumentName, required }) => ({ name: argumentName, required })),
    }))).toEqual(baseline.prompts);
    expect(actual.representative.products.structuredContent.products.map(({ code, priority }) => ({ code, priority })))
      .toEqual(baseline.representative.products);
    expect(actual.representative.scopedRag.structuredContent).toEqual(baseline.representative.scopedRag);
    expect(actual.representative.dryRun.structuredContent).toEqual(baseline.representative.dryRun);
    expect(JSON.parse(actual.representative.resourceRead.contents[0]?.text ?? 'null')).toEqual(baseline.representative.resourceRead);
    expect(actual.qa).toEqual({ generatedFiles: [], secretValuesAbsent: true, stderr: ['sangfor-engineer-mcp stdio server started'] });
  });

  it('rejects a removed or schema-changed baseline tool and an unexpected fourth addition', () => {
    const approved = [...baseline.tools, ...delta.approvedAdditions];
    const removed = approved.filter(({ name }) => name !== baseline.tools[0]?.name);
    const changed = approved.map((tool, index) => index === 0 ? { ...tool, inputSchema: {} } : tool);
    const added = [...approved, { ...delta.approvedAdditions[0], name: 'sangfor_iag_unreviewed_fourth_tool' }];

    expect(() => assertReviewedSurface(removed, baseline, delta)).toThrow();
    expect(() => assertReviewedSurface(changed, baseline, delta)).toThrow();
    expect(() => assertReviewedSurface(added, baseline, delta)).toThrow();
  });

  it('authenticates both immutable fixtures independently of candidate output', () => {
    const { sha256: baselineDigest, ...baselinePayload } = baseline;
    const { sha256: deltaDigest, ...deltaPayload } = delta;
    expect(fixtureDigest(baselinePayload)).toBe(baselineDigest);
    expect(fixtureDigest(deltaPayload)).toBe(deltaDigest);
    expect(delta.baselineCommit).toBe(baseline.source.commit);
  });

  it('keeps every production MCP module within 250 pure LOC', () => {
    const sourceRoot = join(ROOT, 'apps/mcp-server/src');
    const oversized = readdirSync(sourceRoot).filter((name) => name.endsWith('.ts'))
      .map((name) => ({ name, loc: pureLoc(join(sourceRoot, name)) }))
      .filter(({ loc }) => loc > 250);
    expect(oversized).toEqual([]);
    expect(pureLoc(join(sourceRoot, 'index.ts'))).toBeLessThan(250);
  });
});
