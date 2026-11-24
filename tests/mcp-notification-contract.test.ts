import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolRuntime } from '../apps/mcp-server/src/mcp-contracts.js';

const { definition, validate, handler } = vi.hoisted(() => {
  const handler = vi.fn(() => ({ fixture: true }));
  return {
    handler,
    definition: vi.fn<ToolRuntime['definition']>(() => ({
      description: 'Read-only fixture', inputSchema: { type: 'object' }, handler,
    })),
    validate: vi.fn<ToolRuntime['validate']>(() => ({ ok: true })),
  };
});
vi.mock('../apps/mcp-server/src/tool-registry.js', () => ({
  listToolsForProfile: () => [],
  toolRuntime: { entries: [], validatorCount: 0, definition, validate },
}));
import { handle } from '../apps/mcp-server/src/mcp-runtime.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('SANGFOR_TOOL_PROFILE', 'full');
});
afterEach(() => vi.unstubAllEnvs());

describe('MCP notification contract', () => {
  it.each(['notifications/initialized', 'notifications/unknown'])('does not answer %s without an ID', async (method) => {
    expect(await handle({ jsonrpc: '2.0', method })).toBeUndefined();
  });

  it('does not resolve, validate or execute a no-ID tools/call', async () => {
    await handle({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'fixture', arguments: {} } });
    expect([definition.mock.calls.length, validate.mock.calls.length, handler.mock.calls.length]).toEqual([0, 0, 0]);
  });

  it.each([0, ''])('preserves request ID %j and executes its tool exactly once', async (id) => {
    const response = await handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'fixture', arguments: {} } });
    expect(response).toMatchObject({ id, result: { isError: false, structuredContent: { fixture: true } } });
    expect([definition.mock.calls.length, validate.mock.calls.length, handler.mock.calls.length]).toEqual([1, 1, 1]);
  });

  it('preserves the correlated method-not-found response for a request', async () => {
    expect(await handle({ jsonrpc: '2.0', id: 0, method: 'unknown' })).toMatchObject({
      id: 0, error: { code: -32601, message: 'Method not found: unknown' },
    });
  });

  it('preserves correlated tool-resolution errors without executing a handler', async () => {
    definition.mockReturnValueOnce(undefined);
    expect(await handle({ jsonrpc: '2.0', id: 'unknown-tool', method: 'tools/call', params: { name: 'absent' } }))
      .toMatchObject({ id: 'unknown-tool', result: { isError: true } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('preserves correlated argument refusals without executing a handler', async () => {
    validate.mockReturnValueOnce({ ok: false, issues: [{ code: 'fixture', path: '', schemaPath: '' }] });
    expect(await handle({ jsonrpc: '2.0', id: 'bad-arguments', method: 'tools/call', params: { name: 'fixture', arguments: {} } }))
      .toMatchObject({ id: 'bad-arguments', result: { isError: true, structuredContent: { error: { code: 'INVALID_TOOL_ARGUMENTS' } } } });
    expect(handler).not.toHaveBeenCalled();
  });
});
