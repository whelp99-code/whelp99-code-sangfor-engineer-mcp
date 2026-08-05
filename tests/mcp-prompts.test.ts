import { afterEach, beforeAll, describe, expect, it } from 'vitest';

// Importing the MCP server module must NOT start the stdio readline loop.
process.env.MCP_NO_SERVE = '1';

let handle: (req: { jsonrpc: '2.0'; id: number; method: string; params?: unknown }) => Promise<any>;
let listTools: () => Array<{ name: string }>;

beforeAll(async () => {
  const mod = await import('../apps/mcp-server/src/index.js');
  handle = mod.handle as typeof handle;
  listTools = (mod as any).listTools;
});

afterEach(() => {
  delete process.env.SANGFOR_TOOL_PROFILE;
});

describe('MCP prompts capability (W2 C3)', () => {
  it('initialize advertises a prompts capability', async () => {
    const res = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(res.result.capabilities.prompts).toBeTruthy();
  });

  it('prompts/list returns exactly the 3 curated prompts', async () => {
    const res = await handle({ jsonrpc: '2.0', id: 1, method: 'prompts/list' });
    const names = res.result.prompts.map((p: { name: string }) => p.name).sort();
    expect(names).toEqual(['sangfor-config-plan', 'sangfor-health-check', 'sangfor-troubleshoot']);
    for (const p of res.result.prompts) {
      expect(typeof p.name).toBe('string');
      expect(typeof p.description).toBe('string');
    }
  });

  it('prompts/get returns the MCP messages shape: {messages:[{role, content:{type:"text", text}}]}', async () => {
    const res = await handle({ jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name: 'sangfor-health-check' } });
    expect(Array.isArray(res.result.messages)).toBe(true);
    expect(res.result.messages.length).toBeGreaterThan(0);
    for (const m of res.result.messages) {
      expect(typeof m.role).toBe('string');
      expect(m.content.type).toBe('text');
      expect(typeof m.content.text).toBe('string');
      expect(m.content.text.length).toBeGreaterThan(0);
    }
  });

  it('prompts/get on an unknown prompt name is rejected with a clear error, not a fabricated workflow', async () => {
    const res = await handle({ jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name: 'sangfor-does-not-exist' } });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/Unknown prompt/);
  });

  it('every sangfor_* tool name mentioned in a prompt body actually exists in the tool registry', async () => {
    const known = new Set(listTools().map((t) => t.name));
    expect(known.size).toBeGreaterThan(50);

    const listRes = await handle({ jsonrpc: '2.0', id: 1, method: 'prompts/list' });
    const names: string[] = listRes.result.prompts.map((p: { name: string }) => p.name);
    expect(names.length).toBe(3);

    for (const name of names) {
      const getRes = await handle({ jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name } });
      const text: string = getRes.result.messages[0].content.text;
      const mentioned = text.match(/sangfor_[a-z0-9_]+/g) ?? [];
      expect(mentioned.length, `${name} should reference at least one real tool`).toBeGreaterThan(0);
      for (const toolName of mentioned) {
        expect(known.has(toolName), `${name} references ${toolName}, which is not in the tool registry`).toBe(true);
      }
    }
  });

  it('sangfor-health-check follows registry -> advisor tool -> spec evaluate -> evidence order', async () => {
    const res = await handle({ jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name: 'sangfor-health-check' } });
    const text: string = res.result.messages[0].content.text;
    const idx = (s: string) => text.indexOf(s);
    expect(idx('sangfor_agent_manifest')).toBeGreaterThan(-1);
    expect(idx('sangfor_advisor_fortios')).toBeGreaterThan(idx('sangfor_agent_manifest'));
    expect(idx('sangfor_evaluate_config')).toBeGreaterThan(idx('sangfor_advisor_fortios'));
    expect(idx('sangfor_generate_evidence_report')).toBeGreaterThan(idx('sangfor_evaluate_config'));
  });

  it('sangfor-config-plan follows requirements -> plan_config -> risk -> validation order', async () => {
    const res = await handle({ jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name: 'sangfor-config-plan' } });
    const text: string = res.result.messages[0].content.text;
    const idx = (s: string) => text.indexOf(s);
    expect(idx('sangfor_analyze_customer_requirements')).toBeGreaterThan(-1);
    expect(idx('sangfor_generate_config_plan')).toBeGreaterThan(idx('sangfor_analyze_customer_requirements'));
    expect(idx('sangfor_request_approval')).toBeGreaterThan(idx('sangfor_generate_config_plan'));
    expect(idx('sangfor_validate_config_plan')).toBeGreaterThan(idx('sangfor_request_approval'));
  });

  it('sangfor-troubleshoot follows rag_search -> hypothesis -> suggest_rca order', async () => {
    const res = await handle({ jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name: 'sangfor-troubleshoot' } });
    const text: string = res.result.messages[0].content.text;
    const idx = (s: string) => text.indexOf(s);
    expect(idx('sangfor_rag_search')).toBeGreaterThan(-1);
    expect(idx('sangfor_suggest_rca')).toBeGreaterThan(idx('sangfor_rag_search'));
  });

  it('prompts/get accepts a string argument and interpolates it into the rendered text', async () => {
    const res = await handle({
      jsonrpc: '2.0', id: 1, method: 'prompts/get',
      params: { name: 'sangfor-troubleshoot', arguments: { symptom: 'VPN tunnel flapping' } },
    });
    const text: string = res.result.messages[0].content.text;
    expect(text).toMatch(/VPN tunnel flapping/);
  });
});

describe('MCP prompts — SANGFOR_TOOL_PROFILE gating (W2 F3)', () => {
  it('full profile exposes all 3 curated prompts', async () => {
    process.env.SANGFOR_TOOL_PROFILE = 'full';
    const res = await handle({ jsonrpc: '2.0', id: 1, method: 'prompts/list' });
    expect(res.result.prompts.map((p: { name: string }) => p.name).sort()).toEqual([
      'sangfor-config-plan', 'sangfor-health-check', 'sangfor-troubleshoot',
    ]);
  });

  it('advisor profile hides sangfor-config-plan (it references sangfor_generate_config_plan / sangfor_request_approval, both write tools)', async () => {
    process.env.SANGFOR_TOOL_PROFILE = 'advisor';
    const res = await handle({ jsonrpc: '2.0', id: 1, method: 'prompts/list' });
    const names = res.result.prompts.map((p: { name: string }) => p.name);
    expect(names).not.toContain('sangfor-config-plan');
  });

  it('advisor profile rejects prompts/get for sangfor-config-plan with a clear, honest error (not a silently truncated workflow)', async () => {
    process.env.SANGFOR_TOOL_PROFILE = 'advisor';
    const res = await handle({ jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name: 'sangfor-config-plan' } });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toBe("Prompt requires tools hidden in profile 'advisor'");
  });

  it('invariant across all 3 profiles: every listed prompt only references tools that are visible in that same profile', async () => {
    for (const profile of ['advisor', 'operator', 'full'] as const) {
      process.env.SANGFOR_TOOL_PROFILE = profile;
      const visibleTools = new Set(
        (await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools.map((t: { name: string }) => t.name),
      );
      const listRes = await handle({ jsonrpc: '2.0', id: 1, method: 'prompts/list' });
      for (const p of listRes.result.prompts) {
        const getRes = await handle({ jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name: p.name } });
        expect(getRes.error, `${profile}/${p.name} should be gettable since it's listed`).toBeUndefined();
        expect(Array.isArray(getRes.result.messages), `${profile}/${p.name} should return a messages array`).toBe(true);
        const text: string = getRes.result.messages[0].content.text;
        const mentioned = text.match(/sangfor_[a-z0-9_]+/g) ?? [];
        for (const toolName of mentioned) {
          expect(visibleTools.has(toolName), `${profile}: listed prompt ${p.name} references ${toolName}, which is hidden in this profile`).toBe(true);
        }
      }
    }
  });
});
