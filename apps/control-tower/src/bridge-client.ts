import type { SignedApproval } from '../../../packages/sangfor-operator/src/approval.js';
import type { RunSafety } from '../../../packages/sangfor-runs/src/index.js';

export interface BridgeToolSchema {
  type?: string;
  properties?: Record<string, { type?: string; description?: string; default?: unknown; enum?: unknown[] }>;
  required?: string[];
}

export interface BridgeTool {
  name: string;
  description: string;
  inputSchema: BridgeToolSchema;
  annotations: { title: string; readOnlyHint: boolean; destructiveHint: boolean };
  category: string;
}

export interface CallResult {
  ok: boolean;
  data?: unknown;
  errorText?: string;
}

interface McpResultEnvelope {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

const TOOLS_CACHE_MS = 60_000;

export class BridgeClient {
  private toolsCache: { at: number; tools: BridgeTool[] } | null = null;

  constructor(
    private readonly baseUrl: string = process.env.CONTROL_TOWER_BRIDGE_URL ?? 'http://127.0.0.1:3600',
    private readonly token: string | undefined = process.env.SANGFOR_API_TOKEN,
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (this.token) h.authorization = `Bearer ${this.token}`;
    return h;
  }

  // 실패도 값으로 — overview/health 위젯은 브리지가 죽어도 렌더돼야 한다.
  async health(): Promise<{ status: string; mcp: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(3_000) });
      const body = (await res.json()) as { status?: string; mcp?: string };
      return { status: String(body.status ?? 'unknown'), mcp: String(body.mcp ?? 'unknown') };
    } catch {
      return { status: 'unreachable', mcp: 'unknown' };
    }
  }

  async listTools(): Promise<BridgeTool[]> {
    const now = Date.now();
    if (this.toolsCache && now - this.toolsCache.at < TOOLS_CACHE_MS) return this.toolsCache.tools;
    const res = await fetch(`${this.baseUrl}/tools`, { headers: this.headers(), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`bridge /tools HTTP ${res.status}`);
    const body = (await res.json()) as { tools?: BridgeTool[] };
    const tools = Array.isArray(body.tools) ? body.tools : [];
    this.toolsCache = { at: now, tools };
    return tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    approval?: SignedApproval,
    timeoutMs = 35_000, // bridge의 MCP 요청 30초 타임아웃보다 여유 있게
  ): Promise<CallResult> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/tools/call`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ name, arguments: args, ...(approval ? { approval } : {}) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      return { ok: false, errorText: `bridge unreachable: ${error instanceof Error ? error.message : String(error)}` };
    }
    const body = (await res.json().catch(() => null)) as { result?: McpResultEnvelope; error?: string } | null;
    if (!res.ok) return { ok: false, errorText: String(body?.error ?? `bridge HTTP ${res.status}`) };
    const result = body?.result;
    if (!result) return { ok: false, errorText: 'bridge response missing result' };
    const text = result.content?.[0]?.text;
    if (result.isError) return { ok: false, errorText: text ?? 'tool returned isError' };
    if (result.structuredContent !== undefined) return { ok: true, data: result.structuredContent };
    if (typeof text === 'string') {
      try { return { ok: true, data: JSON.parse(text) }; } catch { return { ok: true, data: text }; }
    }
    return { ok: true, data: null };
  }
}

export function safetyOf(t: BridgeTool): RunSafety {
  if (t.annotations.destructiveHint) return 'destructive';
  if (t.annotations.readOnlyHint !== true) return 'write';
  return 'read_only';
}
