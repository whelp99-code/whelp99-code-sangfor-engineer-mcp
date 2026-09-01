import { beforeAll, describe, expect, it } from 'vitest';

process.env.MCP_NO_SERVE = '1';

const EXPECTED = [
  'sangfor_list_learning_strategies',
  'sangfor_resolve_learning_strategy',
  'sangfor_attach_observation_session',
  'sangfor_manage_learning_capture',
  'sangfor_collect_facts',
  'sangfor_research_learning_strategy',
  'sangfor_validate_learning_strategy',
  'sangfor_promote_learning_strategy',
] as const;

let listTools: () => Array<{ name: string; inputSchema: Record<string, unknown>; annotations: { readOnlyHint: boolean; destructiveHint: boolean } }>;
let getToolHandler: (name: string) => ((args: unknown) => unknown) | undefined;

beforeAll(async () => {
  const module = await import('../apps/mcp-server/src/index.js');
  listTools = module.listTools as typeof listTools;
  getToolHandler = module.getToolHandler as typeof getToolHandler;
});

describe('PR-011 learning MCP surface', () => {
  it('registers exactly the eight learning tools in the live inventory', () => {
    const tools = listTools();
    expect(tools.filter((tool) => EXPECTED.includes(tool.name as typeof EXPECTED[number])).map((tool) => tool.name).sort())
      .toEqual([...EXPECTED].sort());
  });

  it('marks list/resolve read-only and the other six as non-destructive local writes', () => {
    const byName = new Map(listTools().map((tool) => [tool.name, tool]));
    for (const [index, name] of EXPECTED.entries()) {
      const tool = byName.get(name)!;
      expect(tool.annotations.destructiveHint, name).toBe(false);
      expect(tool.annotations.readOnlyHint, name).toBe(index < 2);
      expect(tool.inputSchema.additionalProperties, name).toBe(false);
    }
  });

  it('rejects unknown and credential fields in handlers as well as schemas', async () => {
    expect(() => getToolHandler('sangfor_list_learning_strategies')!({ unexpected: true })).toThrow('UNKNOWN_FIELD');
    expect(() => getToolHandler('sangfor_resolve_learning_strategy')!({
      scope: { product: 'ENDPOINT_SECURE', firmwareVersion: '6.0.4', password: 'forbidden' },
      context: { registryDigest: 'a'.repeat(64), versionTruthRecord: 'truth' },
    })).toThrow('SECRET_FIELD_FORBIDDEN');
    expect(() => getToolHandler('sangfor_collect_facts')!({
      scope: { product: 'ENDPOINT_SECURE', firmwareVersion: '6.0.4' },
      context: { registryDigest: 'a'.repeat(64), versionTruthRecord: 'truth', cookie: 'forbidden' },
      factIds: ['version'],
    })).toThrow('SECRET_FIELD_FORBIDDEN');
  });
});
