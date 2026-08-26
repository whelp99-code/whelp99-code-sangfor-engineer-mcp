/**
 * The census schema is depth-bounded, not openly recursive.
 *
 * `z.lazy()` accepts nesting without limit, so the depth of an attacker- or
 * bug-supplied payload decided how deep this process would recurse. The bridge
 * is a local façade, but a census is exactly the kind of input that gets
 * proxied, cached, and replayed, and "we validate it" is not a defence when the
 * validation itself is the unbounded part. The schema now stops at the depth the
 * real server actually emits: five property/item hops below the inputSchema
 * root, measured from the live 115-tool census, with the terminal level refusing
 * any further `properties` or `items` as unknown keys.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { fetchBridgeToolRegistry } from '../packages/sangfor-competency/src/index.js';

// Importing the MCP server module must NOT start the stdio readline loop.
process.env.MCP_NO_SERVE = '1';

interface AdvertisedTool { readonly name: string; readonly inputSchema?: unknown }
let listTools: () => readonly AdvertisedTool[];

beforeAll(async () => {
  const mod = await import('../apps/mcp-server/src/index.js');
  listTools = mod.listTools as typeof listTools;
});

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((done) => s.close(() => done()));
});

const startFakeBridge = async (body: unknown): Promise<string> => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', () => ready()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

/** Counts property/item hops below a schema root, mirroring how the bound is defined. */
const hops = (node: unknown): number => {
  if (typeof node !== 'object' || node === null) return 0;
  const n = node as { properties?: Record<string, unknown>; items?: unknown };
  let deepest = 0;
  for (const child of Object.values(n.properties ?? {})) deepest = Math.max(deepest, 1 + hops(child));
  if (typeof n.items === 'object' && n.items !== null) deepest = Math.max(deepest, 1 + hops(n.items));
  return deepest;
};

/** A chain of `depth` nested hops below the root, ending in a scalar leaf. */
const nestByProperties = (depth: number): Record<string, unknown> => {
  let node: Record<string, unknown> = { type: 'string' };
  for (let i = 0; i < depth; i += 1) node = { type: 'object', properties: { nested: node } };
  return node;
};

const nestByItems = (depth: number): Record<string, unknown> => {
  let node: Record<string, unknown> = { type: 'string' };
  for (let i = 0; i < depth; i += 1) node = { type: 'array', items: node };
  return node;
};

const toolWith = (inputSchema: unknown) => ({
  name: 'sangfor_evaluate_config',
  description: 'Evaluate an observed config against an IntendedSpec.',
  inputSchema,
  annotations: { title: 'Evaluate config', readOnlyHint: true, destructiveHint: false },
  category: 'advisory',
});

const fetchWith = async (inputSchema: unknown) =>
  fetchBridgeToolRegistry(await startFakeBridge({ tools: [toolWith(inputSchema)] }));

describe('census depth bound — the real maximum is accepted', () => {
  it('Given the live 115-tool census, When fetched through the bridge, Then every tool including the deepest schema is accepted', async () => {
    const tools = listTools();
    const registry = await fetchBridgeToolRegistry(await startFakeBridge({ tools }));

    expect(registry.ok, JSON.stringify(registry)).toBe(true);
    if (!registry.ok) return;
    expect(registry.toolNames).toHaveLength(tools.length);
    // Guards the bound against drift: if the server ever emits a deeper schema,
    // this fails here rather than silently refusing a real tool in production.
    expect(Math.max(...tools.map((t) => hops(t.inputSchema)))).toBe(5);
  });

  it('Given a schema nested to exactly the bound via properties, When fetched, Then it is accepted', async () => {
    const registry = await fetchWith(nestByProperties(5));
    expect(registry.ok).toBe(true);
  });

  it('Given a schema nested to exactly the bound via array items, When fetched, Then it is accepted', async () => {
    const registry = await fetchWith(nestByItems(5));
    expect(registry.ok).toBe(true);
  });
});

describe('census depth bound — one level beyond is refused', () => {
  it('Given a schema exactly one property hop past the bound, When fetched, Then it returns a typed schemaInvalid', async () => {
    const registry = await fetchWith(nestByProperties(6));

    expect(registry.ok).toBe(false);
    if (registry.ok) return;
    expect([...new Set(registry.violations.map((v) => v.kind))]).toEqual(['schemaInvalid']);
  });

  it('Given a schema exactly one item hop past the bound, When fetched, Then it returns a typed schemaInvalid', async () => {
    const registry = await fetchWith(nestByItems(6));

    expect(registry.ok).toBe(false);
    if (registry.ok) return;
    expect([...new Set(registry.violations.map((v) => v.kind))]).toEqual(['schemaInvalid']);
  });

  it('Given the terminal depth carries a further properties key, When fetched, Then that key is refused as unknown', async () => {
    let terminal: Record<string, unknown> = { type: 'object', properties: { deeper: { type: 'string' } } };
    for (let i = 0; i < 5; i += 1) terminal = { type: 'object', properties: { nested: terminal } };

    const registry = await fetchWith(terminal);
    expect(registry.ok).toBe(false);
    if (registry.ok) return;
    expect([...new Set(registry.violations.map((v) => v.kind))]).toEqual(['schemaInvalid']);
  });
});

describe('census depth bound — pathological depth degrades to a typed refusal', () => {
  it('Given a 1,000-level nested schema, When fetched, Then it returns a typed refusal without throwing or hanging', async () => {
    // A throw, stack overflow, or hang fails this await outright — resolving to a
    // value IS the "no unbounded recursion" assertion.
    const pending = fetchWith(nestByProperties(1_000));
    await expect(pending).resolves.toMatchObject({ ok: false });

    const registry = await pending;
    expect(registry.ok).toBe(false);
    if (registry.ok) return;
    expect([...new Set(registry.violations.map((v) => v.kind))]).toEqual(['schemaInvalid']);
  });

  it('Given a 1,000-level nested array-items schema, When fetched, Then it also returns a typed refusal', async () => {
    const registry = await fetchWith(nestByItems(1_000));

    expect(registry.ok).toBe(false);
    if (registry.ok) return;
    expect([...new Set(registry.violations.map((v) => v.kind))]).toEqual(['schemaInvalid']);
  });

  it('Given a 1,000-level payload, When it is refused, Then the violation list stays small rather than one entry per level', async () => {
    const registry = await fetchWith(nestByProperties(1_000));

    expect(registry.ok).toBe(false);
    if (registry.ok) return;
    expect(registry.violations.length).toBeLessThan(20);
  });

  it('Given an unknown key alongside deep nesting, When fetched, Then unknown-key refusal still applies', async () => {
    const registry = await fetchWith({ type: 'object', properties: { a: { type: 'string' } }, invented: 'x' });

    expect(registry.ok).toBe(false);
    if (registry.ok) return;
    expect([...new Set(registry.violations.map((v) => v.kind))]).toEqual(['schemaInvalid']);
  });
});
