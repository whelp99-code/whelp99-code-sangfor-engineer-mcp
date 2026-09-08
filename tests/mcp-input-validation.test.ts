import { describe, expect, it, vi } from 'vitest';
import { createToolRuntime } from '../apps/mcp-server/src/tool-validation.js';
import { dispatchToolCall } from '../apps/mcp-server/src/mcp-runtime.js';
import { toolValidatorCount } from '../apps/mcp-server/src/tool-registry.js';
import type { ToolCatalogEntry } from '../apps/mcp-server/src/mcp-contracts.js';

process.env.MCP_NO_SERVE = '1';

const INVALID_ARGUMENTS = 'INVALID_TOOL_ARGUMENTS';

function fakeTool(handler: (args: unknown) => unknown): readonly ToolCatalogEntry[] {
  return [['test_tool', {
    description: 'test',
    inputSchema: {
      type: 'object',
      properties: { requiredValue: { type: 'string' } },
      required: ['requiredValue'],
    },
    handler,
  }]];
}

describe('MCP strict pre-dispatch validation', () => {
  it('compiles one fail-closed validator for every shipped tool', () => {
    // Given the composed production registry.
    // When startup compilation has completed.
    // Then all 118 schemas have validators.
    expect(toolValidatorCount()).toBe(118);
  });

  it('does not invoke a handler when required arguments are missing', async () => {
    // Given a real compiled tool runtime and a handler spy.
    const handler = vi.fn(() => ({ mutationPerformed: true }));
    const runtime = createToolRuntime(fakeTool(handler));

    // When invalid arguments are dispatched through the production dispatcher.
    const result = await dispatchToolCall('test_tool', {}, runtime);

    // Then validation refuses before the handler can run.
    expect(handler).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: INVALID_ARGUMENTS, tool: 'test_tool' } },
    });
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['array', []],
    ['wrong property type', { requiredValue: 7 }],
    ['unknown extra property', { requiredValue: 'ok', password: 'release-secret' }],
  ])('refuses %s input deterministically before dispatch', async (_case, args) => {
    // Given a strict compiled schema and handler spy.
    const handler = vi.fn(() => ({ mutationPerformed: true }));
    const runtime = createToolRuntime(fakeTool(handler));

    // When malformed or extra arguments cross the boundary.
    const result = await dispatchToolCall('test_tool', args, runtime);

    // Then the typed refusal contains no submitted secret value and no side effect occurred.
    expect(handler).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: INVALID_ARGUMENTS } },
    });
    expect(JSON.stringify(result)).not.toContain('release-secret');
  });

  it('preserves explicit map semantics while closing ordinary object schemas', async () => {
    // Given one explicit additionalProperties map and one ordinary object schema.
    const handler = vi.fn((args: unknown) => args);
    const runtime = createToolRuntime([
      ['map_tool', {
        description: 'map',
        inputSchema: { type: 'object', additionalProperties: { type: 'string' } },
        handler,
      }],
      ...fakeTool(handler),
    ]);

    // When each receives an otherwise unknown property.
    const mapResult = await dispatchToolCall('map_tool', { arbitrary: 'allowed' }, runtime);
    const closedResult = await dispatchToolCall('test_tool', { requiredValue: 'ok', arbitrary: 'refused' }, runtime);

    // Then explicit map semantics survive and the implicit closed object refuses.
    expect(mapResult.isError).toBe(false);
    expect(closedResult.isError).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('fails startup compilation on an invalid JSON Schema', () => {
    // Given an invalid type keyword in a tool schema.
    const entries: readonly ToolCatalogEntry[] = [['invalid_schema', {
      description: 'invalid',
      inputSchema: { type: 'not-a-json-schema-type' },
      handler: () => null,
    }]];

    // When startup compiles the catalog, then it fails closed naming the tool only.
    expect(() => createToolRuntime(entries)).toThrow('INVALID_TOOL_SCHEMA: invalid_schema');
  });
});
