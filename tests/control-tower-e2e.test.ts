import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Importing the MCP server module must NOT start the stdio readline loop.
process.env.MCP_NO_SERVE = '1';

import { authorizeToolCall } from '../apps/http-bridge/src/tool-guard.js';
import { createApi } from '../apps/control-tower/src/api.js';
import { SEED_VENDORS } from '../apps/control-tower/src/registry.js';

const SECRET = 'itest-secret';

// ─── T-INT-1: 실제 guard를 태운 in-process bridge ──────────────────────────
const TOOL_LIST = {
  tools: [
    { name: 'itest.read', description: 'stub', inputSchema: { type: 'object', properties: {} }, annotations: { title: 'itest read', readOnlyHint: true, destructiveHint: false }, category: 'admin' },
    { name: 'itest.write', description: 'stub', inputSchema: { type: 'object', properties: {} }, annotations: { title: 'itest write', readOnlyHint: false, destructiveHint: false }, category: 'admin' },
  ],
};

describe('T-INT-1 — 타워 민팅 → 실제 bridge guard → 실행 → 이력 전체 체인', () => {
  let bridgeServer: http.Server;
  let bridgeUrl: string;
  let dir: string;
  let lastCallBody: { name: string; arguments: Record<string, unknown>; approval?: Record<string, unknown> } | null = null;
  const OLD_ENV = { ...process.env };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tower-e2e-'));
    process.env.SANGFOR_NONCE_STORE_PATH = join(dir, 'nonces.json');
    process.env.SANGFOR_OPERATOR_APPROVAL_SECRET = SECRET;

    // 실제 authorizeToolCall(승인 분기 포함)을 쓰는 미니 bridge — 실행부만 stub.
    bridgeServer = http.createServer(async (req, res) => {
      const respond = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.method === 'GET' && req.url === '/health') return respond(200, { status: 'ok', mcp: 'connected' });
      if (req.method === 'GET' && req.url === '/tools') return respond(200, TOOL_LIST);
      if (req.method === 'POST' && req.url === '/tools/call') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        lastCallBody = body;
        const decision = authorizeToolCall({
          name: body.name,
          toolListResult: TOOL_LIST,
          enforceWhitelist: true,
          approval: body.approval,
          approvalSecret: process.env.SANGFOR_OPERATOR_APPROVAL_SECRET,
        });
        if (!decision.allow) return respond(decision.status ?? 403, { error: decision.error });
        const payload = { echo: body.name, args: body.arguments };
        return respond(200, { result: { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload, isError: false } });
      }
      respond(404, { error: 'not found' });
    });
    await new Promise<void>((r) => bridgeServer.listen(0, '127.0.0.1', r));
    bridgeUrl = `http://127.0.0.1:${(bridgeServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => bridgeServer.close(() => r()));
    process.env = { ...OLD_ENV };
    rmSync(dir, { recursive: true, force: true });
  });

  it('읽기 실행 → 이력 / 쓰기 pending → 승인 → guard 통과 → succeeded / 같은 승인 재사용 → 403', async () => {
    const api = createApi({
      bridgeUrl,
      runsDir: join(dir, 'runs'),
      registryDir: join(dir, 'registry'),
      approvalSecret: SECRET,
      mockConsoleUrl: 'http://127.0.0.1:1',
    });

    // ① 읽기전용: guard의 read-only 허용 경로로 즉시 실행
    const read = await api.createRun({ toolId: 'itest.read', args: {} });
    expect(read.status).toBe('succeeded');

    // ② 쓰기: 승인 없이 guard에 직접 던지면 403 (whitelist enforced)
    const direct = await fetch(`${bridgeUrl}/tools/call`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'itest.write', arguments: {} }),
    });
    expect(direct.status).toBe(403);

    // ③ 타워 경유: pending → 승인 → 민팅된 approval이 실제 guard를 통과
    const pending = await api.createRun({ toolId: 'itest.write', args: { customer: 'acme', password: 'hunter2' } });
    expect(pending.status).toBe('pending_approval');
    const final = await api.approveRun(pending.runId, { approvedBy: 'jmpark' });
    expect(final.status).toBe('succeeded');
    expect(final.approval?.approvedBy).toBe('jmpark');
    expect(JSON.stringify(final)).not.toMatch(/approvalToken/); // 이력에 토큰 무저장
    expect(lastCallBody!.arguments.password).toBe('hunter2');   // 원본 args 실행
    expect(lastCallBody!.approval).toBeDefined();

    // ④ R1: 같은 승인(같은 nonce)을 bridge에 직접 재사용 → 403 already used
    const replay = await fetch(`${bridgeUrl}/tools/call`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'itest.write', arguments: {}, approval: lastCallBody!.approval }),
    });
    expect(replay.status).toBe(403);
    expect(String(((await replay.json()) as { error: string }).error)).toMatch(/already used/);

    // ⑤ 이력에 전체 체인 기록 (읽기 1 + 쓰기 1)
    const runs = api.listRuns({});
    expect(runs.filter((r) => r.status === 'succeeded')).toHaveLength(2);

    // ⑥ 거부 플로우
    const pending2 = await api.createRun({ toolId: 'itest.write', args: {} });
    const rejected = api.rejectRun(pending2.runId, { reason: 'not now' });
    expect(rejected.status).toBe('rejected');
  });
});

// ─── T-INT-2: vendors.json 시드 ↔ 실제 MCP 도구 대조 ────────────────────────
describe('T-INT-2 — 시드 advisorTools가 실제 MCP에 존재하고 전부 read-only', () => {
  let byName: Map<string, { name: string; annotations: { readOnlyHint: boolean; destructiveHint: boolean }; inputSchema: { properties?: Record<string, unknown> } }>;

  beforeAll(async () => {
    const mod = await import('../apps/mcp-server/src/index.js');
    const listTools = (mod as { listTools: () => any[] }).listTools;
    byName = new Map((listTools() as Array<{ name: string; annotations: { readOnlyHint: boolean; destructiveHint: boolean }; inputSchema: { properties?: Record<string, unknown> } }>).map((t) => [t.name, t]));
  });

  it('모든 시드 advisorTool이 존재하고 readOnly:true / destructive:false', () => {
    for (const vendor of SEED_VENDORS) {
      for (const toolName of vendor.advisorTools) {
        const tool = byName.get(toolName);
        expect(tool, `${vendor.product}: ${toolName} 미존재`).toBeTruthy();
        expect(tool!.annotations.readOnlyHint, `${toolName} readOnlyHint`).toBe(true);
        expect(tool!.annotations.destructiveHint, `${toolName} destructiveHint`).toBe(false);
      }
    }
  });

  it('모든 credentialField가 해당 벤더 모든 advisorTool의 inputSchema 속성에 존재 (시드 오타 방지)', () => {
    for (const vendor of SEED_VENDORS) {
      for (const toolName of vendor.advisorTools) {
        const properties = Object.keys(byName.get(toolName)!.inputSchema.properties ?? {});
        for (const field of vendor.credentialFields) {
          expect(properties, `${vendor.product}/${toolName}: credentialField '${field}'가 스키마에 없음`).toContain(field);
        }
      }
    }
  });
});
