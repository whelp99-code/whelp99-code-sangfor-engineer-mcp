/**
 * whelp99 MCP HTTP bridge
 * Wraps stdio JSON-RPC MCP server with REST endpoints expected by AIOSv2 Portal,
 * plus a standard MCP Streamable HTTP endpoint for remote MCP clients.
 *
 * Endpoints:
 *   GET  /health
 *   GET  /tools
 *   POST /tools/call  { name, arguments? }
 *   POST /mcp         JSON-RPC 2.0, single request/response (see docs/adapters/remote-http.md)
 */

import http from "node:http";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveBindHost, checkAuth, assertBindSafety, isLoopback } from "../../../packages/shared/src/index.js";
import { authorizeToolCall } from "./tool-guard.js";
import type { SignedApproval } from "../../../packages/sangfor-operator/src/approval.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const MCP_ENTRY = join(REPO_ROOT, "apps/mcp-server/src/index.ts");

const PORT = Number(process.env.PORT ?? process.env.WHELP99_HTTP_BRIDGE_PORT ?? 3600);
const BIND_HOST = resolveBindHost();
const API_TOKEN = process.env.SANGFOR_API_TOKEN;
const REMOTE_BIND = !isLoopback(BIND_HOST);
const ALLOW_REMOTE_WRITE = process.env.SANGFOR_ALLOW_REMOTE_WRITE === "true";

export type JsonRpcResponse = {
  jsonrpc: string;
  id?: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
};

export type McpRequestFn = (method: string, params?: unknown) => Promise<JsonRpcResponse>;

// ── default stdio child transport (production) ──────────────────────────────
// A single lazily-spawned child serves every request for the life of the
// process; requests are matched to responses by numeric id via `pending`.
let mcpChild: ChildProcessWithoutNullStreams | null = null;
let requestId = 0;
const pending = new Map<
  number,
  { resolve: (v: JsonRpcResponse) => void; reject: (e: Error) => void }
>();

function startMcpChild(): ChildProcessWithoutNullStreams {
  const child = spawn("pnpm", ["exec", "tsx", MCP_ENTRY], {
    cwd: REPO_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line) as JsonRpcResponse;
      if (msg.id !== undefined && pending.has(Number(msg.id))) {
        const handler = pending.get(Number(msg.id))!;
        pending.delete(Number(msg.id));
        handler.resolve(msg);
      }
    } catch {
      // ignore non-json stderr noise routed to stdout
    }
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[mcp] ${chunk}`);
  });

  child.on("exit", (code) => {
    process.stderr.write(`[mcp] exited with code ${code}\n`);
    mcpChild = null;
    for (const [, handler] of pending) {
      handler.reject(new Error("MCP child process exited"));
    }
    pending.clear();
  });

  return child;
}

async function defaultMcpRequest(method: string, params?: unknown): Promise<JsonRpcResponse> {
  if (!mcpChild) {
    mcpChild = startMcpChild();
    await defaultMcpRequest("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "http-bridge", version: "0.1.0" },
    });
  }

  const id = ++requestId;
  const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP request timeout: ${method}`));
    }, 30_000);

    pending.set(id, {
      resolve: (msg) => {
        clearTimeout(timeout);
        resolve(msg);
      },
      reject: (err) => {
        clearTimeout(timeout);
        reject(err);
      },
    });

    mcpChild!.stdin.write(`${payload}\n`);
  });
}

function killDefaultMcpChild(): void {
  mcpChild?.kill();
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

function json(res: http.ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

// Standard MCP Streamable HTTP over POST /mcp is intentionally stateless
// (single JSON-RPC request in, single response out — no SSE stream, no
// Mcp-Session-Id). Only these methods are proxied through; anything else
// gets a JSON-RPC -32601, mirroring how mcp-server's own handle() already
// rejects methods outside this exact set. tools/call additionally has to
// clear authorizeToolCall — the SAME gate /tools/call uses — before it is
// forwarded; see docs/adapters/remote-http.md for the documented limits.
// SECURITY ASSUMPTION: resources/* and prompts/* pass with token auth only
// because mcp-server serves exclusively static curated metadata there (agent
// manifest, capabilities, safety posture, workflow prompt text). If a future
// resource ever exposes gated or per-device data, it needs its own guard here.
const MCP_HTTP_ALLOWED_METHODS = new Set([
  "initialize",
  "tools/list",
  "tools/call",
  "resources/list",
  "resources/read",
  "prompts/list",
  "prompts/get",
]);

export interface BridgeServerDeps {
  mcpRequest?: McpRequestFn;
  apiToken?: string;
  remoteBind?: boolean;
  allowRemoteWrite?: boolean;
  port?: number;
}

/**
 * Build the bridge's request handler as a plain (unstarted) http.Server.
 * Callers own bind/listen — production binds PORT/BIND_HOST behind
 * assertBindSafety (see startProductionServer below); tests bind
 * `listen(0, '127.0.0.1')` and never touch a real MCP child process by
 * passing a stub via `deps.mcpRequest`.
 *
 * Route behavior/auth/guards for /health, /tools, /tools/call are byte-for-byte
 * identical to the pre-refactor module-level server — only the wiring moved.
 */
export function createBridgeServer(deps: BridgeServerDeps = {}): http.Server {
  const mcpRequest = deps.mcpRequest ?? defaultMcpRequest;
  const apiToken = deps.apiToken ?? API_TOKEN;
  const remoteBind = deps.remoteBind ?? REMOTE_BIND;
  const allowRemoteWrite = deps.allowRemoteWrite ?? ALLOW_REMOTE_WRITE;
  const port = deps.port ?? PORT;

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

    // Shared-secret gate for tool routes (health stays open for liveness probes).
    if (url.pathname === "/tools" || url.pathname === "/tools/call" || url.pathname === "/mcp") {
      const auth = checkAuth(req.headers["authorization"], apiToken);
      if (!auth.ok) return json(res, { error: "unauthorized" }, auth.status ?? 401);
    }

    try {
      if (req.method === "GET" && url.pathname === "/health") {
        const init = await mcpRequest("tools/list");
        const ok = !init.error;
        return json(res, {
          status: ok ? "ok" : "degraded",
          bridge: "whelp99-mcp-http-bridge",
          mcp: ok ? "connected" : "error",
          port,
        }, ok ? 200 : 503);
      }

      if (req.method === "GET" && url.pathname === "/tools") {
        const list = await mcpRequest("tools/list");
        if (list.error) {
          return json(res, { error: list.error.message, tools: [] }, 502);
        }
        const tools =
          (list.result as { tools?: unknown[] })?.tools ?? [];
        return json(res, { tools });
      }

      if (req.method === "POST" && url.pathname === "/tools/call") {
        const body = await readJsonBody(req);
        const name = typeof body.name === "string" ? body.name : "";
        const args = body.arguments ?? body.args ?? {};
        const approval = body.approval && typeof body.approval === "object"
          ? (body.approval as SignedApproval)
          : undefined;

        if (!name) {
          return json(res, { error: "name is required" }, 400);
        }

        const enforceWhitelist = process.env.WHELP99_ENFORCE_SAFE_TOOLS !== "false";
        const list = await mcpRequest("tools/list");
        const decision = authorizeToolCall({
          name,
          toolListResult: list.error ? null : list.result,
          enforceWhitelist,
          remoteBind,
          allowRemoteWrite,
          approval,
          approvalSecret: process.env.SANGFOR_OPERATOR_APPROVAL_SECRET,
        });
        if (!decision.allow) {
          return json(res, { error: decision.error }, decision.status ?? 403);
        }

        const call = await mcpRequest("tools/call", { name, arguments: args });
        if (call.error) {
          return json(res, { error: call.error.message }, 502);
        }
        return json(res, { result: call.result });
      }

      if (url.pathname === "/mcp") {
        if (req.method !== "POST") {
          return json(res, { error: "Method not allowed; POST /mcp only (stateless, no SSE)" }, 405);
        }

        const body = await readJsonBody(req);
        const rpcId = (body as { id?: string | number | null }).id ?? null;
        const method = typeof body.method === "string" ? body.method : "";

        if (!MCP_HTTP_ALLOWED_METHODS.has(method)) {
          return json(res, { jsonrpc: "2.0", id: rpcId, error: { code: -32601, message: `Method not found: ${method}` } });
        }

        if (method === "tools/call") {
          const params = (body.params ?? {}) as { name?: unknown; arguments?: unknown; approval?: unknown };
          const name = typeof params.name === "string" ? params.name : "";
          if (!name) {
            return json(res, { jsonrpc: "2.0", id: rpcId, error: { code: -32602, message: "Invalid params: name is required" } });
          }
          const approval = params.approval && typeof params.approval === "object"
            ? (params.approval as SignedApproval)
            : undefined;

          // SAME gate as /tools/call — see authorizeToolCall in tool-guard.ts.
          // Do not duplicate or weaken this logic; call the shared function.
          const enforceWhitelist = process.env.WHELP99_ENFORCE_SAFE_TOOLS !== "false";
          const list = await mcpRequest("tools/list");
          const decision = authorizeToolCall({
            name,
            toolListResult: list.error ? null : list.result,
            enforceWhitelist,
            remoteBind,
            allowRemoteWrite,
            approval,
            approvalSecret: process.env.SANGFOR_OPERATOR_APPROVAL_SECRET,
          });
          if (!decision.allow) {
            // Same gate outcome as /tools/call, but /mcp speaks JSON-RPC — a
            // conforming MCP client needs an error envelope it can correlate.
            return json(
              res,
              { jsonrpc: "2.0", id: rpcId, error: { code: -32000, message: decision.error } },
              decision.status ?? 403,
            );
          }
        }

        const rpcResult = await mcpRequest(method, body.params);
        // JSON-RPC contract: the response id must echo the CLIENT's request id.
        // mcpRequest correlates over the stdio child with its own internal ids,
        // so rewrite before returning to the HTTP caller.
        return json(res, { ...rpcResult, id: rpcId });
      }

      return json(res, { error: "Not found" }, 404);
    } catch (error) {
      return json(
        res,
        { error: error instanceof Error ? error.message : String(error) },
        500,
      );
    }
  });
}

function startProductionServer(): void {
  assertBindSafety(BIND_HOST, API_TOKEN); // fail closed: no public bind without a token
  const server = createBridgeServer();

  server.listen(PORT, BIND_HOST, () => {
    console.log(`whelp99 MCP HTTP bridge listening on http://${BIND_HOST}:${PORT}${API_TOKEN ? " (token-gated)" : ""}`);
  });

  process.on("SIGINT", () => {
    killDefaultMcpChild();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    killDefaultMcpChild();
    process.exit(0);
  });
}

// Guard: importing this module (e.g. from tests) must not assert bind safety
// or bind a port. Same convention as apps/mcp-server's MCP_NO_SERVE/VITEST guard.
if (process.env.BRIDGE_NO_SERVE !== "1" && process.env.VITEST === undefined) {
  startProductionServer();
}
