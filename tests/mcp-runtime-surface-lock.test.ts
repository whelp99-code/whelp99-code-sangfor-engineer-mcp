import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { captureMcpRuntimeSurface } from './helpers/mcp-runtime-surface-driver.js';

const ROOT = resolve(import.meta.dirname, '..');
const FIXTURE_PATH = join(ROOT, 'tests/fixtures/mcp-runtime-surface-v1.json');

function pureLoc(path: string): number {
  return readFileSync(path, 'utf8').split('\n').filter((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith('//');
  }).length;
}

describe('MCP runtime shipped-surface lock', () => {
  it('keeps the v1 descriptor/resource/prompt lock and valid representative results unchanged', async () => {
    // Given the committed pre-validation surface, which is immutable rather than regenerated.
    const expected = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
    expect(expected.sha256).toBe('009bbd66366710134b779f2c72e253e2510eec5319818047e1dd7d910a9ce4f0');
    const { sha256: _sha256, ...lockedSurface } = expected;
    expect(createHash('sha256').update(JSON.stringify(lockedSurface)).digest('hex')).toBe(expected.sha256);

    // When the shipped entrypoint is exercised in a clean generated-data environment.
    const actual = JSON.parse(JSON.stringify(await captureMcpRuntimeSurface(ROOT)));

    // Then shipped discovery copies and valid calls remain byte-identical; malformed behavior is v2-owned.
    expect({
      initialize: actual.initialize,
      tools: actual.tools,
      resources: actual.resources,
      prompts: actual.prompts,
      promptGet: actual.promptGet,
      representative: {
        products: actual.representative.products,
        scopedRag: actual.representative.scopedRag,
        dryRun: actual.representative.dryRun,
        resourceRead: actual.representative.resourceRead,
      },
    }).toEqual({
      initialize: expected.initialize,
      tools: expected.tools,
      resources: expected.resources,
      prompts: expected.prompts,
      promptGet: expected.promptGet,
      representative: {
        products: expected.representative.products,
        scopedRag: expected.representative.scopedRag,
        dryRun: expected.representative.dryRun,
        resourceRead: expected.representative.resourceRead,
      },
    });
  }, 60_000);

  it('keeps the live census complete and unambiguous', () => {
    // Given the canonical shipped artifact.
    const artifact = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));

    // When its advertised surfaces are counted.
    const names = artifact.tools.map((tool: { name: string }) => tool.name);

    // Then all 118 tools, boolean annotations, resources, and prompts remain present.
    expect(names).toHaveLength(118);
    expect(new Set(names).size).toBe(118);
    expect(artifact.tools.every((tool: { annotations: { readOnlyHint: unknown; destructiveHint: unknown } }) =>
      typeof tool.annotations.readOnlyHint === 'boolean' && typeof tool.annotations.destructiveHint === 'boolean')).toBe(true);
    expect(artifact.resources.resources).toHaveLength(3);
    expect(artifact.prompts.prompts).toHaveLength(3);
    expect(artifact.qa).toEqual({
      generatedFiles: [],
      secretValuesAbsent: true,
      stderr: ['sangfor-engineer-mcp stdio server started'],
    });
  });

  it('keeps the composition entry and every production MCP module within 250 pure LOC', () => {
    // Given every production TypeScript module in the MCP app.
    const sourceRoot = join(ROOT, 'apps/mcp-server/src');
    const modules = readdirSync(sourceRoot).filter((name) => name.endsWith('.ts'));

    // When pure source lines are measured.
    const oversized = modules.map((name) => ({ name, loc: pureLoc(join(sourceRoot, name)) }))
      .filter(({ loc }) => loc > 250);

    // Then no module exceeds the reviewed-plan ceiling.
    expect(oversized).toEqual([]);
    expect(pureLoc(join(sourceRoot, 'index.ts'))).toBeLessThan(250);
  });
});
