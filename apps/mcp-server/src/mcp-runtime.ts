import { getPrompt, listPrompts } from './mcp-prompts.js';
import { listResources, readResource } from './mcp-resources.js';
import type { ToolRuntime } from './mcp-contracts.js';
import { listToolsForProfile, toolRuntime } from './tool-registry.js';
import { activeToolProfile, annotationsFor, isToolVisibleInProfile } from './tool-profile.js';

export type JsonRpcRequest = { jsonrpc: '2.0'; id?: string | number; method: string; params?: any };

const DEFAULT_RESULT_MAX_CHARS = 100_000;

function resolveResultMaxChars(): number {
  const raw = process.env.SANGFOR_MCP_RESULT_MAX_CHARS;
  if (raw === undefined) return DEFAULT_RESULT_MAX_CHARS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_RESULT_MAX_CHARS;
}

// Cap the tools/call payload: an unbounded chunk/log/atom dump can blow past
// a client's context budget. Caps on serialized char length — UTF-16 code units,
// not bytes, matching the SANGFOR_MCP_RESULT_MAX_CHARS name (independent of the
// disk-side cap in packages/sangfor-runs/run-store.ts's capResultJson — this one
// governs what actually crosses the MCP wire) and replaces BOTH content[0].text
// and structuredContent with the same truncation marker so a client can't read
// full detail from one field after the other was capped.
function capMcpResult(toolName: string, result: unknown): { result: unknown; text: string } {
  const text = JSON.stringify(result);
  const maxChars = resolveResultMaxChars();
  if (text.length <= maxChars) return { result, text };
  const capped = { truncated: true, tool: toolName, originalChars: text.length, hint: 'narrow the query or use pagination/cursor inputs' };
  return { result: capped, text: JSON.stringify(capped) };
}

export async function dispatchToolCall(name: string, args: unknown, runtime: ToolRuntime = toolRuntime) {
  const tool = runtime.definition(name);
  if (tool === undefined) throw new Error(`Unknown tool: ${name}`);
  const profile = activeToolProfile();
  if (profile !== 'full' && !isToolVisibleInProfile({ annotations: annotationsFor(name, tool.description) }, profile)) {
    throw new Error(`Tool not available in profile '${profile}'; set SANGFOR_TOOL_PROFILE=full`);
  }
  const validation = runtime.validate(name, args);
  if (!validation.ok) {
    const structuredContent = {
      error: {
        code: 'INVALID_TOOL_ARGUMENTS',
        tool: name,
        issues: validation.issues,
      },
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
      structuredContent,
      isError: true,
    };
  }
  const raw = await tool.handler(args);
  const { result, text } = capMcpResult(name, raw);
  return { content: [{ type: 'text', text }], structuredContent: result, isError: false };
}

export async function handle(req: JsonRpcRequest) {
  try {
    if (req.method === 'initialize') {
      return { jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'sangfor-engineer-mcp', version: '0.1.0' }, capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, prompts: { listChanged: false } } } };
    }
    if (req.method === 'tools/list') {
      return { jsonrpc: '2.0', id: req.id, result: { tools: listToolsForProfile() } };
    }
    if (req.method === 'resources/list') {
      return { jsonrpc: '2.0', id: req.id, result: { resources: listResources() } };
    }
    if (req.method === 'resources/read') {
      const uri = req.params?.uri;
      return { jsonrpc: '2.0', id: req.id, result: readResource(uri) };
    }
    if (req.method === 'prompts/list') {
      return { jsonrpc: '2.0', id: req.id, result: { prompts: listPrompts() } };
    }
    if (req.method === 'prompts/get') {
      const name = req.params?.name;
      const args = req.params?.arguments;
      return { jsonrpc: '2.0', id: req.id, result: getPrompt(name, args) };
    }
    if (req.method === 'tools/call') {
      const name = req.params?.name;
      const args = req.params?.arguments;
      return { jsonrpc: '2.0', id: req.id, result: await dispatchToolCall(name, args) };
    }
    return { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `Method not found: ${req.method}` } };
  } catch (error) {
    return { jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: String(error instanceof Error ? error.message : error) }], isError: true } };
  }
}
