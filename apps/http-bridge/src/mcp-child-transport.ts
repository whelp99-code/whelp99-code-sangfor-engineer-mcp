/**
 * Default stdio child transport for the HTTP bridge (production path).
 *
 * A single lazily-spawned MCP child serves every request for the life of the
 * process; requests are matched to responses by numeric id via `pending`.
 * Bodies below are a verbatim move out of server.ts — routing lives there,
 * child-process correlation lives here.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { RuntimeSchemaError } from "../../../packages/shared/src/runtime-schema.js";
import { parseBoundaryHttpBridgeResponseV1 } from "./runtime-boundaries.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const MCP_ENTRY = join(REPO_ROOT, "apps/mcp-server/src/index.ts");

type JsonRpcResponseIdentity = {
  readonly jsonrpc: string;
  readonly id?: string | number | null;
};

export type JsonRpcResponse = JsonRpcResponseIdentity & (
  | {
    readonly result: unknown;
    readonly error?: never;
  }
  | {
    readonly result?: never;
    readonly error: { readonly code: number; readonly message: string };
  }
);

export type McpRequestFn = (method: string, params?: unknown) => Promise<JsonRpcResponse>;

class McpChildUnavailableError extends Error {
  readonly name = 'McpChildUnavailableError';

  constructor() {
    super('MCP child process became unavailable');
  }
}

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
      const message = parseBoundaryHttpBridgeResponseV1(line);
      if (message.id === undefined) return;
      const id = Number(message.id);
      const handler = pending.get(id);
      if (handler === undefined) return;
      pending.delete(id);
      handler.resolve(message);
    } catch (error) {
      // A frame that satisfies neither response arm leaves every in-flight
      // call without a verdict: the child may have run the tool, or not.
      // Fail them all loudly rather than hand one an empty success.
      if (!(error instanceof RuntimeSchemaError)) throw error;
      process.stderr.write('[mcp] response is INDETERMINATE: strict JSON contract rejected stdout\n');
      for (const [, handler] of pending) handler.reject(error);
      pending.clear();
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

export async function defaultMcpRequest(method: string, params?: unknown): Promise<JsonRpcResponse> {
  if (!mcpChild) {
    mcpChild = startMcpChild();
    await defaultMcpRequest("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "http-bridge", version: "0.1.0" },
    });
  }

  const child = mcpChild;
  if (child === null) throw new McpChildUnavailableError();

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

    child.stdin.write(`${payload}\n`);
  });
}

export function killDefaultMcpChild(): void {
  mcpChild?.kill();
}
