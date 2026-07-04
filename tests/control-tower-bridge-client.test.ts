import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { BridgeClient, safetyOf, type BridgeTool } from '../apps/control-tower/src/bridge-client.js';

// 프로그래머블 stub bridge: 케이스별 응답을 큐로 제어한다.
let stub: http.Server;
let base: string;
let toolsResponse: unknown;
let callResponse: { status: number; body: unknown };
let lastCall: { headers: http.IncomingHttpHeaders; body: Record<string, unknown> } | null = null;
let toolsHits = 0;

beforeAll(async () => {
  stub = http.createServer(async (req, res) => {
    const respond = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/health') return respond(200, { status: 'ok', mcp: 'connected' });
    if (req.method === 'GET' && req.url === '/tools') { toolsHits += 1; return respond(200, toolsResponse); }
    if (req.method === 'POST' && req.url === '/tools/call') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      lastCall = { headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
      return respond(callResponse.status, callResponse.body);
    }
    respond(404, { error: 'not found' });
  });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => stub.close(() => r())));

const tool = (name: string, ro: boolean, destructive = false): BridgeTool => ({
  name, description: 'd', inputSchema: { type: 'object', properties: {} },
  annotations: { title: name, readOnlyHint: ro, destructiveHint: destructive }, category: 'admin',
});

describe('BridgeClient', () => {
  it('listTools는 Bearer 토큰을 붙이고 60초 캐시한다', async () => {
    const client = new BridgeClient(base, 'tok-1');
    toolsResponse = { tools: [tool('a.read', true)] };
    toolsHits = 0;
    const first = await client.listTools();
    expect(first.map((t) => t.name)).toEqual(['a.read']);
    toolsResponse = { tools: [] }; // 서버 응답을 바꿔도
    const second = await client.listTools();
    expect(second.map((t) => t.name)).toEqual(['a.read']); // 캐시 히트
    expect(toolsHits).toBe(1);
  });

  it('callTool: structuredContent 우선 파싱 + approval/arguments 전달 + Bearer 헤더', async () => {
    const client = new BridgeClient(base, 'tok-2');
    const payload = { evaluation: { ok: true } };
    callResponse = { status: 200, body: { result: { content: [{ type: 'text', text: 'ignored' }], structuredContent: payload, isError: false } } };
    const approval = { approvedBy: 'a', approvalToken: 't', changeTicketId: 'c', rollbackPlanId: 'r', nonce: 'n', expiresAt: 'e' };
    const result = await client.callTool('x.tool', { q: 1 }, approval);
    expect(result).toEqual({ ok: true, data: payload });
    expect(lastCall!.headers.authorization).toBe('Bearer tok-2');
    expect(lastCall!.body).toEqual({ name: 'x.tool', arguments: { q: 1 }, approval });
  });

  it('callTool: structuredContent 없으면 content[0].text JSON.parse, 비JSON이면 raw text', async () => {
    const client = new BridgeClient(base);
    callResponse = { status: 200, body: { result: { content: [{ type: 'text', text: '{"a":1}' }], isError: false } } };
    expect(await client.callTool('x', {})).toEqual({ ok: true, data: { a: 1 } });
    callResponse = { status: 200, body: { result: { content: [{ type: 'text', text: 'plain' }], isError: false } } };
    expect(await client.callTool('x', {})).toEqual({ ok: true, data: 'plain' });
  });

  it('callTool: isError → ok:false + errorText', async () => {
    const client = new BridgeClient(base);
    callResponse = { status: 200, body: { result: { content: [{ type: 'text', text: 'tool blew up' }], isError: true } } };
    expect(await client.callTool('x', {})).toEqual({ ok: false, errorText: 'tool blew up' });
  });

  it('callTool: bridge 거부(403 {error})는 값으로 반환한다', async () => {
    const client = new BridgeClient(base);
    callResponse = { status: 403, body: { error: 'Destructive tool refused' } };
    expect(await client.callTool('x', {})).toEqual({ ok: false, errorText: 'Destructive tool refused' });
  });

  it('bridge 다운: health는 unreachable 값, callTool은 ok:false 값 (throw 금지)', async () => {
    const dead = new BridgeClient('http://127.0.0.1:1'); // 연결 불가 포트
    expect((await dead.health()).status).toBe('unreachable');
    const call = await dead.callTool('x', {});
    expect(call.ok).toBe(false);
    expect(call.errorText).toMatch(/bridge unreachable/);
  });

  it('safetyOf: destructive > write > read_only', () => {
    expect(safetyOf(tool('a', false, true))).toBe('destructive');
    expect(safetyOf(tool('a', false))).toBe('write');
    expect(safetyOf(tool('a', true))).toBe('read_only');
  });
});
