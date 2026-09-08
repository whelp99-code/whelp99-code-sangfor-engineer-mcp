import { testFileLocalWriteAuthority, testLocalWriteAuthority } from './local-write-authority.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTowerServer } from '../../apps/control-tower/src/server.js';
import { Registry, type VendorDescriptor } from '../../apps/control-tower/src/registry.js';
import type { RunRecord } from '@sangfor/runs';

// ─── stub bridge ────────────────────────────────────────────────────────────
const STUB_TOOLS = {
  tools: [
    {
      name: 'stub.read', description: 'echo read',
      inputSchema: {
        type: 'object',
        properties: { host: { type: 'string' }, username: { type: 'string' }, password: { type: 'string' }, specVersion: { type: 'string', default: '1.0' } },
        required: ['host', 'username', 'password'],
      },
      annotations: { title: 'stub read', readOnlyHint: true, destructiveHint: false }, category: 'advisory',
    },
    {
      name: 'stub.write', description: 'echo write',
      inputSchema: { type: 'object', properties: { customer: { type: 'string' }, password: { type: 'string' } }, required: ['customer'] },
      annotations: { title: 'stub write', readOnlyHint: false, destructiveHint: false }, category: 'pm',
    },
    {
      name: 'stub.fail', description: 'always isError',
      inputSchema: { type: 'object', properties: {} },
      annotations: { title: 'stub fail', readOnlyHint: true, destructiveHint: false }, category: 'admin',
    },
  ],
};

let stubBridge: http.Server;
let bridgeUrl: string;
let lastCall: { name: string; arguments: Record<string, unknown>; approval?: Record<string, unknown> } | null;

function startStubBridge(): Promise<void> {
  stubBridge = http.createServer(async (req, res) => {
    const respond = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/health') return respond(200, { status: 'ok', mcp: 'connected' });
    if (req.method === 'GET' && req.url === '/tools') return respond(200, STUB_TOOLS);
    if (req.method === 'POST' && req.url === '/tools/call') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      lastCall = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      // 실제 bridge처럼 목록에 없는 도구는 403 — Task 8 health 테스트의 store/rag 프로브가 이 경로를 탄다
      if (!STUB_TOOLS.tools.some((t) => t.name === lastCall!.name)) {
        return respond(403, { error: 'Tool annotations unavailable; refusing call: ' + lastCall!.name });
      }
      if (lastCall!.name === 'stub.fail') {
        return respond(200, { result: { content: [{ type: 'text', text: 'stub tool exploded: ' + JSON.stringify(lastCall!.arguments) }], isError: true } });
      }
      const payload = lastCall!.name === 'stub.read'
        ? { evaluation: { specId: 's', ok: true, items: [], summary: { pass: 3, fail: 0, indeterminate: 0 }, coverage: {} } }
        : { created: true, echo: lastCall!.arguments, note: 'ran with password ' + String((lastCall!.arguments as Record<string, unknown>).password ?? '') };
      return respond(200, { result: { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload, isError: false } });
    }
    respond(404, { error: 'not found' });
  });
  return new Promise((r) => stubBridge.listen(0, '127.0.0.1', () => {
    bridgeUrl = `http://127.0.0.1:${(stubBridge.address() as AddressInfo).port}`;
    r();
  }));
}

// ─── tower 기동 헬퍼 ────────────────────────────────────────────────────────
let runsDir: string;
let registryDir: string;
let tower: http.Server;
let towerUrl: string;

export function startTower(opts: Record<string, unknown> = {}): Promise<http.Server> {
  const server = createTowerServer({ authorityMode: 'local',
    bridgeUrl, runsDir, registryDir,
    approvalSecret: 'api-secret', apiToken: 'test-token',
    mockConsoleUrl: 'http://127.0.0.1:1',
    ...opts,
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

export const urlOf = (server: http.Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

export async function call(method: string, path: string, body?: unknown, base?: string, token = 'test-token') {
  const res = await fetch(`${base ?? towerUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

beforeEach(async () => {
  runsDir = mkdtempSync(join(tmpdir(), 'tower-runs-'));
  registryDir = mkdtempSync(join(tmpdir(), 'tower-reg-'));
  lastCall = null;
  await startStubBridge();
  tower = await startTower();
  towerUrl = urlOf(tower);
});

afterEach(async () => {
  await new Promise<void>((r) => tower.close(() => r()));
  await new Promise<void>((r) => stubBridge.close(() => r()));
  rmSync(runsDir, { recursive: true, force: true });
  rmSync(registryDir, { recursive: true, force: true });
});

export const registryRoot = (): string => registryDir;
export const runsRoot = (): string => runsDir;
export const towerAddress = (): string => towerUrl;
export const bridgeAddress = (): string => bridgeUrl;
export const observedCall = (): typeof lastCall => lastCall;
