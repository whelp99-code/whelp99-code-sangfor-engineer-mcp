/**
 * whelp99 MCP HTTP bridge
 * Wraps stdio JSON-RPC MCP server with REST endpoints expected by AIOSv2 Portal.
 *
 * Endpoints:
 *   GET  /health
 *   GET  /tools
 *   POST /tools/call  { name, arguments? }
 */

import http from "node:http";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const MCP_ENTRY = join(REPO_ROOT, "apps/mcp-server/src/index.ts");

/** Read-only tools allowed for live device-control smoke without mutation. */
export const SAFE_TOOL_WHITELIST = new Set([
  "sangfor.products",
  "sangfor.search_manuals",
  "sangfor.get_manual_section",
  "sangfor.rag_search",
  "sangfor.rag_index_summary",
  "sangfor.store_health",
]);

const PORT = Number(process.env.PORT ?? process.env.WHELP99_HTTP_BRIDGE_PORT ?? 3600);

type JsonRpcResponse = {
  jsonrpc: string;
  id?: string | number;
  result?: unknown;
  error?: { code: number; message: string };
};

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

async function mcpRequest(method: string, params?: unknown): Promise<JsonRpcResponse> {
  if (!mcpChild) {
    mcpChild = startMcpChild();
    await mcpRequest("initialize", {
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);

  try {
    if (req.method === "GET" && url.pathname === "/health") {
      const init = await mcpRequest("tools/list");
      const ok = !init.error;
      return json(res, {
        status: ok ? "ok" : "degraded",
        bridge: "whelp99-mcp-http-bridge",
        mcp: ok ? "connected" : "error",
        port: PORT,
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

      if (!name) {
        return json(res, { error: "name is required" }, 400);
      }

      const enforceWhitelist = process.env.WHELP99_ENFORCE_SAFE_TOOLS !== "false";
      if (enforceWhitelist && !SAFE_TOOL_WHITELIST.has(name)) {
        return json(
          res,
          {
            error: `Tool not in safe whitelist: ${name}`,
            allowedTools: [...SAFE_TOOL_WHITELIST],
          },
          403,
        );
      }

      const call = await mcpRequest("tools/call", { name, arguments: args });
      if (call.error) {
        return json(res, { error: call.error.message }, 502);
      }
      return json(res, { result: call.result });
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

server.listen(PORT, () => {
  console.log(`whelp99 MCP HTTP bridge listening on http://localhost:${PORT}`);
});

process.on("SIGINT", () => {
  mcpChild?.kill();
  process.exit(0);
});

process.on("SIGTERM", () => {
  mcpChild?.kill();
  process.exit(0);
});
