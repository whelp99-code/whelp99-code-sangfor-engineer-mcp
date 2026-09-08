/**
 * FIX A — the bridge census contract is closed at every modelled boundary.
 *
 * `inputSchema` was not modelled at all and the objects around it were open, so
 * a response could carry arbitrary extra keys and still be accepted as the
 * authoritative tool census. An unknown key means the payload is not the shape
 * we think it is; accepting it lets whatever produced it decide what counts as a
 * registered tool, which is the exact self-assertion this source exists to stop.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { fetchBridgeToolRegistry } from '../packages/sangfor-competency/src/index.js';

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

/** Mirrors a real entry from the live server's tools/list, inputSchema included. */
const realTool = (over: Record<string, unknown> = {}) => ({
  name: 'sangfor_evaluate_config',
  description: 'Evaluate an observed config against an IntendedSpec.',
  inputSchema: {
    type: 'object',
    properties: {
      product: { type: 'string', description: 'Product code' },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      tags: { type: 'array', items: { type: 'string' }, minItems: 1 },
      dryRun: { type: 'boolean', default: true },
      mode: { type: 'string', enum: ['fast', 'full'] },
    },
    required: ['product'],
    additionalProperties: false,
  },
  annotations: { title: 'Evaluate config', readOnlyHint: true, destructiveHint: false },
  category: 'advisory',
  ...over,
});

const kinds = async (body: unknown): Promise<readonly string[]> => {
  const registry = await fetchBridgeToolRegistry(await startFakeBridge(body));
  if (registry.ok) return [];
  return [...new Set(registry.violations.map((v) => v.kind))];
};

describe('bridge census — the real inputSchema shape is modelled, not ignored', () => {
  it('Given a response carrying a genuine nested inputSchema, When fetched, Then it is accepted', async () => {
    const registry = await fetchBridgeToolRegistry(await startFakeBridge({ tools: [realTool()] }));
    expect(registry.ok).toBe(true);
    if (!registry.ok) return;
    expect(registry.toolNames).toEqual(['sangfor_evaluate_config']);
  });

  it('Given a tool with no inputSchema at all, When fetched, Then it is refused', async () => {
    const { inputSchema: _dropped, ...withoutSchema } = realTool();
    expect(await kinds({ tools: [withoutSchema] })).toEqual(['schemaInvalid']);
  });

  it('Given an inputSchema property of an unmodelled type, When fetched, Then it is refused', async () => {
    expect(await kinds({
      tools: [realTool({ inputSchema: { type: 'object', properties: { x: { type: 'quantum' } } } })],
    })).toEqual(['schemaInvalid']);
  });

  it('Given an unknown key INSIDE the nested inputSchema, When fetched, Then it is refused', async () => {
    expect(await kinds({
      tools: [realTool({ inputSchema: { type: 'object', properties: { x: { type: 'string', invented: 'sneaks in' } } } })],
    })).toEqual(['schemaInvalid']);
  });

  it('Given an unknown key at the inputSchema root, When fetched, Then it is refused', async () => {
    expect(await kinds({
      tools: [realTool({ inputSchema: { type: 'object', properties: {}, invented: 'sneaks in' } })],
    })).toEqual(['schemaInvalid']);
  });
});

describe('bridge census — unknown keys are refused at every level', () => {
  it("Given the verifier's accepted response with an invented ROOT key, When fetched, Then it is now refused", async () => {
    expect(await kinds({ tools: [realTool()], invented: 'accepted before this fix' })).toEqual(['schemaInvalid']);
  });

  it("Given the verifier's accepted response with an invented TOOL key, When fetched, Then it is now refused", async () => {
    expect(await kinds({ tools: [realTool({ invented: 'accepted before this fix' })] })).toEqual(['schemaInvalid']);
  });

  it("Given the verifier's accepted response with an invented ANNOTATION key, When fetched, Then it is now refused", async () => {
    expect(await kinds({
      tools: [realTool({ annotations: { title: 'Evaluate config', readOnlyHint: true, destructiveHint: false, invented: 'accepted before this fix' } })],
    })).toEqual(['schemaInvalid']);
  });

  it('Given an invented key on a nested array item schema, When fetched, Then it is refused', async () => {
    expect(await kinds({
      tools: [realTool({ inputSchema: { type: 'object', properties: { tags: { type: 'array', items: { type: 'string', invented: 'x' } } } } })],
    })).toEqual(['schemaInvalid']);
  });

  it('Given an invented key survives nowhere, When a clean census is fetched, Then the tool still grounds normally', async () => {
    const registry = await fetchBridgeToolRegistry(await startFakeBridge({ tools: [realTool(), realTool({ name: 'sangfor_suggest_rca' })] }));
    expect(registry.ok).toBe(true);
    if (!registry.ok) return;
    expect([...registry.toolNames].sort()).toEqual(['sangfor_evaluate_config', 'sangfor_suggest_rca']);
  });
});
