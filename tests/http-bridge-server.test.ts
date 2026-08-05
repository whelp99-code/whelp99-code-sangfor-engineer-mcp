import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';

// Importing the bridge module must NOT assert bind safety or bind a real port.
// Same convention as apps/mcp-server's MCP_NO_SERVE/VITEST guard.
process.env.BRIDGE_NO_SERVE = '1';

type JsonRpcResponse = {
  jsonrpc: string;
  id?: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
};
type McpRequestFn = (method: string, params?: unknown) => Promise<JsonRpcResponse>;
let createBridgeServer: (deps?: {
  mcpRequest?: McpRequestFn;
  apiToken?: string;
  remoteBind?: boolean;
  allowRemoteWrite?: boolean;
  port?: number;
}) => http.Server;

beforeAll(async () => {
  const mod = await import('../apps/http-bridge/src/server.js');
  createBridgeServer = mod.createBridgeServer;
});

// A stub tools/list carrying one read-only and one destructive-hinted tool —
// enough to exercise authorizeToolCall's fail-closed destructive rule without
// touching a real MCP child process.
const STUB_TOOLS = {
  tools: [
    { name: 'ro.tool', annotations: { readOnlyHint: true, destructiveHint: false } },
    { name: 'destructive.tool', annotations: { readOnlyHint: false, destructiveHint: true } },
  ],
};

function makeFakeMcpRequest(): McpRequestFn {
  return async (method: string, _params?: unknown) => {
    if (method === 'initialize') {
      return { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'stub' } } };
    }
    if (method === 'tools/list') {
      return { jsonrpc: '2.0', id: 2, result: STUB_TOOLS };
    }
    if (method === 'tools/call') {
      return { jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: '{"ok":true}' }], isError: false } };
    }
    return { jsonrpc: '2.0', id: 9, result: {} };
  };
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function postJson(base: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

let servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  servers = [];
});

// ── C1: refactor did not change existing route behavior ────────────────────
describe('createBridgeServer — C1: existing routes unchanged after the testability refactor', () => {
  it('/health stays open even when a token is configured (no Authorization header needed)', async () => {
    const server = createBridgeServer({ apiToken: 'secret-token', mcpRequest: makeFakeMcpRequest() });
    servers.push(server);
    const base = await listen(server);
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.mcp).toBe('connected');
  });

  it('/tools 401s with no Bearer token when a token is configured', async () => {
    const server = createBridgeServer({ apiToken: 'secret-token', mcpRequest: makeFakeMcpRequest() });
    servers.push(server);
    const base = await listen(server);
    const res = await fetch(`${base}/tools`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('/tools succeeds with the correct Bearer token', async () => {
    const server = createBridgeServer({ apiToken: 'secret-token', mcpRequest: makeFakeMcpRequest() });
    servers.push(server);
    const base = await listen(server);
    const res = await fetch(`${base}/tools`, { headers: { authorization: 'Bearer secret-token' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tools.map((t: { name: string }) => t.name)).toEqual(['ro.tool', 'destructive.tool']);
  });
});

// ── C2: standard MCP Streamable HTTP endpoint (stateless, single response) ──
describe('createBridgeServer — C2: POST /mcp', () => {
  it('initialize round-trips through mcpRequest', async () => {
    const server = createBridgeServer({ mcpRequest: makeFakeMcpRequest() });
    servers.push(server);
    const base = await listen(server);
    const res = await postJson(base, '/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'stub' } } });
  });

  it("echoes the CLIENT's request id even when the stdio child used a different internal id", async () => {
    const server = createBridgeServer({ mcpRequest: makeFakeMcpRequest() });
    servers.push(server);
    const base = await listen(server);
    // fake child answers initialize with id:1 — the HTTP response must still carry ours
    const res = await postJson(base, '/mcp', { jsonrpc: '2.0', id: 'client-42', method: 'initialize', params: {} });
    expect(res.status).toBe(200);
    expect((await res.json() as { id: unknown }).id).toBe('client-42');
  });

  it('tools/list round-trips through mcpRequest', async () => {
    const server = createBridgeServer({ mcpRequest: makeFakeMcpRequest() });
    servers.push(server);
    const base = await listen(server);
    const res = await postJson(base, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jsonrpc: '2.0', id: 2, result: STUB_TOOLS });
  });

  it('a read-only tools/call round-trips through mcpRequest after clearing the guard', async () => {
    const server = createBridgeServer({ mcpRequest: makeFakeMcpRequest() });
    servers.push(server);
    const base = await listen(server);
    const res = await postJson(base, '/mcp', {
      jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'ro.tool', arguments: {} },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jsonrpc: '2.0', id: 4, result: { content: [{ type: 'text', text: '{"ok":true}' }], isError: false } });
  });

  it('a method outside the allowlist returns a JSON-RPC -32601 error', async () => {
    const server = createBridgeServer({ mcpRequest: makeFakeMcpRequest() });
    servers.push(server);
    const base = await listen(server);
    const res = await postJson(base, '/mcp', { jsonrpc: '2.0', id: 5, method: 'notifications/foo', params: {} });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jsonrpc: '2.0', id: 5, error: { code: -32601, message: 'Method not found: notifications/foo' } });
  });

  it('GET /mcp is 405 (stateless, no SSE)', async () => {
    const server = createBridgeServer({ mcpRequest: makeFakeMcpRequest() });
    servers.push(server);
    const base = await listen(server);
    const res = await fetch(`${base}/mcp`);
    expect(res.status).toBe(405);
  });

  it('DELETE /mcp is 405 (no session to terminate — stateless)', async () => {
    const server = createBridgeServer({ mcpRequest: makeFakeMcpRequest() });
    servers.push(server);
    const base = await listen(server);
    const res = await fetch(`${base}/mcp`, { method: 'DELETE' });
    expect(res.status).toBe(405);
  });

  it('an unapproved destructive tools/call is refused with the same 403 authorizeToolCall produces on /tools/call', async () => {
    const server = createBridgeServer({ mcpRequest: makeFakeMcpRequest() });
    servers.push(server);
    const base = await listen(server);
    const res = await postJson(base, '/mcp', {
      jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'destructive.tool', arguments: {} },
    });
    expect(res.status).toBe(403);
    // /mcp speaks JSON-RPC: the same gate verdict arrives as an error envelope
    // the client can correlate by id (the legacy /tools/call keeps its REST shape).
    expect(await res.json()).toEqual({
      jsonrpc: '2.0', id: 6,
      error: { code: -32000, message: 'Destructive tool refused by MCP annotations: destructive.tool' },
    });
  });

  it('POST /mcp is 401 with no Bearer token when a token is configured', async () => {
    const server = createBridgeServer({ apiToken: 'secret-token', mcpRequest: makeFakeMcpRequest() });
    servers.push(server);
    const base = await listen(server);
    const res = await postJson(base, '/mcp', { jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });
});
