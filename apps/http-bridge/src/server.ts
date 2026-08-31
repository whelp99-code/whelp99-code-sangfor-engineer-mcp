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
import { ZodError } from 'zod';
import { resolveBindHost, checkAuth, assertBindSafety, isLoopback } from "../../../packages/shared/src/index.js";
import {
  MAX_REQUEST_BODY_BYTES,
  RequestBodyTooLargeError,
  readCappedRequestBody,
} from "../../../packages/shared/src/runtime-body-cap.js";
import { authorizeToolCall } from "../../../packages/sangfor-operator/src/tool-authorization.js";
import type { SignedApproval } from "../../../packages/sangfor-operator/src/approval.js";
import { RuntimeSchemaError } from "../../../packages/shared/src/runtime-schema.js";
import {
  decodeHttpBridgeMcpRequestBody,
  decodeHttpBridgeToolCallParams,
  decodeHttpBridgeToolsCallBody,
  decodeHttpBridgeToolsListResult,
  parseBoundaryHttpBridgeRequestBodyV1,
  type HttpBridgeRequestBody,
} from "./runtime-boundaries.js";
import {
  defaultMcpRequest,
  killDefaultMcpChild,
  type McpRequestFn,
} from "./mcp-child-transport.js";

export type { JsonRpcResponse, McpRequestFn } from "./mcp-child-transport.js";

const PORT = Number(process.env.PORT ?? process.env.WHELP99_HTTP_BRIDGE_PORT ?? 3600);
const BIND_HOST = resolveBindHost();
const API_TOKEN = process.env.SANGFOR_API_TOKEN;
const REMOTE_BIND = !isLoopback(BIND_HOST);
const ALLOW_REMOTE_WRITE = process.env.SANGFOR_ALLOW_REMOTE_WRITE === "true";

async function readJsonBody(req: http.IncomingMessage): Promise<HttpBridgeRequestBody> {
  const raw = await readCappedRequestBody(req, MAX_REQUEST_BODY_BYTES);
  return parseBoundaryHttpBridgeRequestBodyV1(raw.trim() ? raw : '{}');
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
// clear @sangfor/operator's authorizeToolCall — the SAME gate /tools/call uses — before it is
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
        const { tools } = decodeHttpBridgeToolsListResult(list.result);
        return json(res, { tools });
      }

      if (req.method === "POST" && url.pathname === "/tools/call") {
        const body = decodeHttpBridgeToolsCallBody(await readJsonBody(req));
        const name = body.name ?? "";
        const args = body.arguments ?? body.args ?? {};
        const approval: SignedApproval | undefined = body.approval;

        if (!name) {
          return json(res, { error: "name is required" }, 400);
        }

        const enforceWhitelist = process.env.WHELP99_ENFORCE_SAFE_TOOLS !== "false";
        const list = await mcpRequest("tools/list");
        const decision = await authorizeToolCall({
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

        const body = decodeHttpBridgeMcpRequestBody(await readJsonBody(req));
        const rpcId = body.id ?? null;
        const method = body.method;

        if (!MCP_HTTP_ALLOWED_METHODS.has(method)) {
          return json(res, { jsonrpc: "2.0", id: rpcId, error: { code: -32601, message: `Method not found: ${method}` } });
        }

        if (method === "tools/call") {
          const params = decodeHttpBridgeToolCallParams(body.params ?? {});
          const name = typeof params.name === "string" ? params.name : "";
          if (!name) {
            return json(res, { jsonrpc: "2.0", id: rpcId, error: { code: -32602, message: "Invalid params: name is required" } });
          }
          const approval: SignedApproval | undefined = params.approval;

          // SAME gate as /tools/call — see authorizeToolCall in @sangfor/operator.
          // Do not duplicate or weaken this logic; call the shared function.
          const enforceWhitelist = process.env.WHELP99_ENFORCE_SAFE_TOOLS !== "false";
          const list = await mcpRequest("tools/list");
          const decision = await authorizeToolCall({
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
      if (error instanceof RequestBodyTooLargeError) {
        return json(res, { error: 'request body too large' }, 413);
      }
      if (error instanceof ZodError || (error instanceof RuntimeSchemaError && error.policy === 'deny')) {
        return json(res, { error: 'invalid JSON request body' }, 400);
      }
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
