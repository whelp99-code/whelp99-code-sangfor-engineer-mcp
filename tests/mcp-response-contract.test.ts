import { afterEach, beforeAll, describe, expect, it } from 'vitest';

// Importing the MCP server module must NOT start the stdio readline loop.
process.env.MCP_NO_SERVE = '1';

let handle: (req: { jsonrpc: '2.0'; id: number; method: string; params?: unknown }) => Promise<any>;

beforeAll(async () => {
  const mod = await import('../apps/mcp-server/src/index.js');
  handle = mod.handle as typeof handle;
});

afterEach(() => {
  delete process.env.SANGFOR_MCP_RESULT_MAX_CHARS;
});

describe('MCP tools/call response contract — compact serialization', () => {
  it('serializes content[0].text with JSON.stringify(result) — no pretty-print indentation', async () => {
    const res = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'sangfor_products', arguments: {} } });
    const text: string = res.result.content[0].text;
    expect(text).not.toMatch(/\n/); // pretty-print (indent 2) always contains newlines; compact never does
    expect(text).toBe(JSON.stringify(res.result.structuredContent));
  });

  it('content[0].text parses back to exactly structuredContent', async () => {
    const res = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'sangfor_products', arguments: {} } });
    expect(JSON.parse(res.result.content[0].text)).toEqual(res.result.structuredContent);
  });
});

describe('MCP tools/call response contract — SANGFOR_MCP_RESULT_MAX_CHARS byte cap', () => {
  it('truncates both content[0].text and structuredContent once the serialized result exceeds the cap', async () => {
    process.env.SANGFOR_MCP_RESULT_MAX_CHARS = '10';
    const res = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'sangfor_products', arguments: {} } });
    expect(res.result.structuredContent).toMatchObject({
      truncated: true,
      tool: 'sangfor_products',
      hint: 'narrow the query or use pagination/cursor inputs',
    });
    expect(res.result.structuredContent.originalChars).toBeGreaterThan(10);
    expect(JSON.parse(res.result.content[0].text)).toEqual(res.result.structuredContent);
  });

  it('does not truncate when the result fits under the cap', async () => {
    process.env.SANGFOR_MCP_RESULT_MAX_CHARS = '1000000';
    const res = await handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'sangfor_products', arguments: {} } });
    expect(res.result.structuredContent.truncated).toBeUndefined();
  });

  it('falls back to the 100000-char default when the env var fails to parse as an integer', async () => {
    process.env.SANGFOR_MCP_RESULT_MAX_CHARS = 'not-a-number';
    const res = await handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'sangfor_products', arguments: {} } });
    // sangfor_products is well under 100,000 chars — no truncation under the default.
    expect(res.result.structuredContent.truncated).toBeUndefined();
  });

  it('falls back to the default when the env var is zero or negative', async () => {
    process.env.SANGFOR_MCP_RESULT_MAX_CHARS = '0';
    const res = await handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'sangfor_products', arguments: {} } });
    expect(res.result.structuredContent.truncated).toBeUndefined();
  });
});
