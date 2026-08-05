import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// Importing the MCP server module must NOT start the stdio readline loop.
process.env.MCP_NO_SERVE = '1';

let handle: (req: { jsonrpc: '2.0'; id: number; method: string; params?: unknown }) => Promise<any>;

beforeAll(async () => {
  const mod = await import('../apps/mcp-server/src/index.js');
  handle = mod.handle as typeof handle;
});

afterEach(() => {
  delete process.env.SANGFOR_TOOL_PROFILE;
});

async function toolNames(profile?: string): Promise<string[]> {
  if (profile === undefined) delete process.env.SANGFOR_TOOL_PROFILE;
  else process.env.SANGFOR_TOOL_PROFILE = profile;
  const res = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  return res.result.tools.map((t: { name: string }) => t.name);
}

describe('SANGFOR_TOOL_PROFILE — tools/list exposure (W2 C1)', () => {
  it('defaults to full when unset — backward compatible with every existing client', async () => {
    const unset = await toolNames(undefined);
    const full = await toolNames('full');
    expect(unset.sort()).toEqual(full.sort());
    expect(unset.length).toBeGreaterThan(50); // sanity: the real 90+ tool registry, not a stub
  });

  it('an empty-string profile value stays full (unset/empty is the same "not configured" case)', async () => {
    const empty = await toolNames('');
    const full = await toolNames('full');
    expect(empty.sort()).toEqual(full.sort());
  });

  it('FAIL-CLOSED: a non-empty unrecognized profile value falls back to the most-restrictive advisor, with a stderr warning', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const typoed = await toolNames('operato'); // typo of 'operator'
    // Assert on the spy BEFORE mockRestore() — restoring also clears recorded calls.
    expect(stderrSpy).toHaveBeenCalled();
    const warned = stderrSpy.mock.calls.some(([msg]) => typeof msg === 'string' && msg.includes("unrecognized SANGFOR_TOOL_PROFILE 'operato'") && msg.includes("falling back to most-restrictive 'advisor'"));
    expect(warned).toBe(true);
    stderrSpy.mockRestore();

    const advisor = await toolNames('advisor');
    expect(typoed.sort()).toEqual(advisor.sort());
  });

  it('advisor is a strict subset of operator, which is a strict subset of full', async () => {
    const advisor = new Set(await toolNames('advisor'));
    const operator = new Set(await toolNames('operator'));
    const full = new Set(await toolNames('full'));

    expect(advisor.size).toBeGreaterThan(0);
    expect(advisor.size).toBeLessThan(operator.size);
    expect(operator.size).toBeLessThan(full.size);

    for (const n of advisor) expect(operator.has(n)).toBe(true);
    for (const n of operator) expect(full.has(n)).toBe(true);
  });

  it('advisor tools/list contains only readOnlyHint:true tools', async () => {
    process.env.SANGFOR_TOOL_PROFILE = 'advisor';
    const res = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    for (const t of res.result.tools) {
      expect(t.annotations.readOnlyHint, t.name).toBe(true);
      expect(t.annotations.destructiveHint, t.name).toBe(false);
    }
  });

  it('operator tools/list never contains a destructive tool', async () => {
    process.env.SANGFOR_TOOL_PROFILE = 'operator';
    const res = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    for (const t of res.result.tools) {
      expect(t.annotations.destructiveHint, t.name).toBe(false);
    }
  });

  it('a destructive tool (e.g. sangfor_apply_approved_product_change) is only visible in full', async () => {
    const name = 'sangfor_apply_approved_product_change';
    expect(await toolNames('advisor')).not.toContain(name);
    expect(await toolNames('operator')).not.toContain(name);
    expect(await toolNames('full')).toContain(name);
  });
});

describe('SANGFOR_TOOL_PROFILE — tools/call honest rejection of hidden tools (W2 C1)', () => {
  it('rejects a call to a write tool while in advisor profile with a clear, actionable error', async () => {
    process.env.SANGFOR_TOOL_PROFILE = 'advisor';
    const res = await handle({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'sangfor_generate_config_plan', arguments: { customerName: 'x', product: 'HCI_SCP' } },
    });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toBe("Tool not available in profile 'advisor'; set SANGFOR_TOOL_PROFILE=full");
  });

  it('rejects a call to a destructive tool while in operator profile', async () => {
    process.env.SANGFOR_TOOL_PROFILE = 'operator';
    const res = await handle({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'sangfor_apply_approved_product_change', arguments: {} },
    });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toBe("Tool not available in profile 'operator'; set SANGFOR_TOOL_PROFILE=full");
  });

  it('still distinguishes an unknown tool name from a hidden-by-profile tool', async () => {
    process.env.SANGFOR_TOOL_PROFILE = 'advisor';
    const res = await handle({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'sangfor_does_not_exist', arguments: {} },
    });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toBe('Unknown tool: sangfor_does_not_exist');
  });

  it('a read-only tool call succeeds in advisor profile', async () => {
    process.env.SANGFOR_TOOL_PROFILE = 'advisor';
    const res = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'sangfor_products', arguments: {} } });
    expect(res.result.isError).toBe(false);
  });

  it('a write-but-not-destructive tool call succeeds in operator profile', async () => {
    process.env.SANGFOR_TOOL_PROFILE = 'operator';
    const res = await handle({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'sangfor_generate_config_plan', arguments: { customerName: 'x', product: 'HCI_SCP' } },
    });
    expect(res.result.isError).toBe(false);
  });

  it('full profile can still call every tool the advisor/operator profiles hide', async () => {
    process.env.SANGFOR_TOOL_PROFILE = 'full';
    const res = await handle({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'sangfor_request_approval', arguments: { text: 'restart the device' } },
    });
    expect(res.result.isError).toBe(false);
  });
});

describe('agent-manifest reports the active profile and dynamic per-profile counts (W2 C2)', () => {
  it('activeProfile and toolCountByProfile reflect SANGFOR_TOOL_PROFILE and match tools/list counts', async () => {
    process.env.SANGFOR_TOOL_PROFILE = 'operator';
    const manifestRes = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'sangfor_agent_manifest', arguments: {} } });
    const manifest = manifestRes.result.structuredContent;
    expect(manifest.activeProfile).toBe('operator');

    const advisorCount = (await toolNames('advisor')).length;
    const operatorCount = (await toolNames('operator')).length;
    const fullCount = (await toolNames('full')).length;
    expect(manifest.toolCountByProfile).toEqual({ advisor: advisorCount, operator: operatorCount, full: fullCount });
    expect(typeof manifest.profileDescriptions.advisor).toBe('string');
    expect(typeof manifest.profileDescriptions.operator).toBe('string');
    expect(typeof manifest.profileDescriptions.full).toBe('string');
    expect(typeof manifest.quickstart.stdio).toBe('string');
  });
});
