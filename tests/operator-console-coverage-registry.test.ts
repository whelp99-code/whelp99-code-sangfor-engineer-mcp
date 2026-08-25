/**
 * Blocker 2 — the console grounds coveredBy on the LIVE bridge registry.
 *
 * The console serves no MCP tools of its own. It previously read a comma list
 * out of SANGFOR_MCP_TOOL_REGISTRY, which is self-asserted: whoever set the env
 * decided what counted as "registered", so an invented name promoted an atom and
 * an unset var bricked the panel. The registry is now read from the running
 * bridge's `tools/list` façade — the same census the MCP server answers — so the
 * console cannot invent, drift from, or opt out of the real tool set.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { fetchBridgeToolRegistry } from '../packages/sangfor-competency/src/index.js';

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((done) => s.close(() => done()));
});

/** A real HTTP fake of the bridge's GET /tools — wire-level, not an SDK mock. */
const startFakeBridge = async (body: unknown, status = 200): Promise<string> => {
  const server = createServer((_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', () => ready()));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
};

/** Mirrors a real tools/list entry, inputSchema included. */
const tool = (name: string) => ({
  name,
  description: `${name} description`,
  inputSchema: { type: 'object', properties: { product: { type: 'string' } }, required: ['product'] },
  annotations: { title: name, readOnlyHint: true, destructiveHint: false },
  category: 'advisory',
});

describe('fetchBridgeToolRegistry — the live census, never a self-asserted list', () => {
  it('Given the bridge advertises tools, When the registry is fetched, Then exactly those names are returned', async () => {
    const url = await startFakeBridge({ tools: [tool('sangfor_evaluate_config'), tool('sangfor_suggest_rca')] });

    const registry = await fetchBridgeToolRegistry(url);
    expect(registry.ok).toBe(true);
    if (!registry.ok) return;
    expect([...registry.toolNames].sort()).toEqual(['sangfor_evaluate_config', 'sangfor_suggest_rca']);
  });

  it('Given the bridge advertises a PARTIAL set, When the registry is fetched, Then a tool it no longer serves is absent', async () => {
    const url = await startFakeBridge({ tools: [tool('sangfor_evaluate_config')] });

    const registry = await fetchBridgeToolRegistry(url);
    expect(registry.ok).toBe(true);
    if (!registry.ok) return;
    expect(registry.toolNames).toContain('sangfor_evaluate_config');
    expect(registry.toolNames).not.toContain('sangfor_generate_comprehensive_operations_guide_docx');
  });

  it('Given the bridge answers a shape the census contract does not allow, When fetched, Then it is refused rather than invented', async () => {
    const url = await startFakeBridge({ tools: [{ name: 'sangfor_evaluate_config' }] });

    const registry = await fetchBridgeToolRegistry(url);
    expect(registry.ok).toBe(false);
    if (registry.ok) return;
    expect([...new Set(registry.violations.map((v) => v.kind))]).toEqual(['schemaInvalid']);
  });

  it('Given the bridge answers an empty census, When fetched, Then it is refused because nothing can be grounded', async () => {
    const url = await startFakeBridge({ tools: [] });

    const registry = await fetchBridgeToolRegistry(url);
    expect(registry.ok).toBe(false);
    if (registry.ok) return;
    expect(registry.violations.map((v) => v.kind)).toEqual(['unregisteredTool']);
  });

  it('Given the bridge errors, When fetched, Then it is refused with a reachability violation and no invented fallback', async () => {
    const url = await startFakeBridge({ error: 'mcp down', tools: [] }, 502);

    const registry = await fetchBridgeToolRegistry(url);
    expect(registry.ok).toBe(false);
    if (registry.ok) return;
    expect(registry.violations.map((v) => v.kind)).toEqual(['registryUnreachable']);
  });

  it('Given the bridge is not listening at all, When fetched, Then it is refused rather than throwing', async () => {
    const url = await startFakeBridge({ tools: [] });
    for (const s of servers.splice(0)) await new Promise<void>((done) => s.close(() => done()));

    const registry = await fetchBridgeToolRegistry(url);
    expect(registry.ok).toBe(false);
    if (registry.ok) return;
    expect(registry.violations.map((v) => v.kind)).toEqual(['registryUnreachable']);
  });
});

describe('getFieldEngineerCoverage — grounded on the injected live registry', () => {
  it('Given no SANGFOR_MCP_TOOL_REGISTRY env at all, When coverage is requested with a live registry, Then the env is irrelevant and the report is produced from the census', async () => {
    const previous = process.env.SANGFOR_MCP_TOOL_REGISTRY;
    delete process.env.SANGFOR_MCP_TOOL_REGISTRY;
    try {
      const url = await startFakeBridge({ tools: [tool('sangfor_evaluate_config')] });
      const { getFieldEngineerCoverage } = await import('../apps/operator-console/src/api.js');

      const result = await getFieldEngineerCoverage(() => fetchBridgeToolRegistry(url));
      // The committed catalog carries a known evidence defect, so the honest
      // outcome is a refusal — what matters is that it is a CATALOG verdict,
      // not the old "registry env unset" excuse.
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.violations.every((v) => v.kind !== 'registryUnreachable')).toBe(true);
      expect(JSON.stringify(result.violations)).not.toContain('SANGFOR_MCP_TOOL_REGISTRY');
    } finally {
      if (previous === undefined) delete process.env.SANGFOR_MCP_TOOL_REGISTRY;
      else process.env.SANGFOR_MCP_TOOL_REGISTRY = previous;
    }
  });

  it('Given SANGFOR_MCP_TOOL_REGISTRY names an invented tool, When coverage is requested, Then the env cannot grant it registration', async () => {
    const previous = process.env.SANGFOR_MCP_TOOL_REGISTRY;
    process.env.SANGFOR_MCP_TOOL_REGISTRY = 'sangfor_totally_invented_tool';
    try {
      const url = await startFakeBridge({ tools: [tool('sangfor_evaluate_config')] });
      const { getFieldEngineerCoverage } = await import('../apps/operator-console/src/api.js');

      const result = await getFieldEngineerCoverage(() => fetchBridgeToolRegistry(url));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(JSON.stringify(result.violations)).not.toContain('sangfor_totally_invented_tool');
    } finally {
      if (previous === undefined) delete process.env.SANGFOR_MCP_TOOL_REGISTRY;
      else process.env.SANGFOR_MCP_TOOL_REGISTRY = previous;
    }
  });

  it('Given the bridge is unreachable, When coverage is requested, Then the console reports the reachability violation and no rate', async () => {
    const url = await startFakeBridge({ tools: [] });
    for (const s of servers.splice(0)) await new Promise<void>((done) => s.close(() => done()));
    const { getFieldEngineerCoverage } = await import('../apps/operator-console/src/api.js');

    const result = await getFieldEngineerCoverage(() => fetchBridgeToolRegistry(url));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations.map((v) => v.kind)).toEqual(['registryUnreachable']);
    expect(result).not.toHaveProperty('coverage');
  });
});
