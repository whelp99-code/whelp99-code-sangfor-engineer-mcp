import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Importing the MCP server module must NOT start the stdio readline loop.
process.env.MCP_NO_SERVE = '1';

let getToolHandler: (name: string) => ((args: unknown) => unknown | Promise<unknown>) | undefined;
let dir: string;
let previousSpecRoot: string | undefined;

beforeAll(async () => {
  const mcp = await import('../apps/mcp-server/src/index.js');
  getToolHandler = mcp.getToolHandler as typeof getToolHandler;
  dir = mkdtempSync(join(tmpdir(), 'mcp-collect-prov-'));
  // Minimal EPP spec so the evaluation path produces an observedSource.
  previousSpecRoot = process.env.SANGFOR_SPEC_ROOT;
  const specDir = join(dir, 'specs', 'EPP', '9.9.9');
  mkdirSync(specDir, { recursive: true });
  writeFileSync(join(specDir, 'baseline.spec.json'), JSON.stringify({
    id: 'epp_prov_fixture',
    product: 'ENDPOINT_SECURE',
    items: [{
      id: 'patch_latest',
      capabilityId: 'patching',
      label: 'Patch definitions are current',
      observedKey: 'patchIsLatest',
      op: 'eq',
      expected: true,
      severity: 'must',
      source: { manual: 'EPP Manual', section: 'Patching' }
    }]
  }));
  process.env.SANGFOR_SPEC_ROOT = join(dir, 'specs');
});

afterAll(() => {
  if (previousSpecRoot === undefined) delete process.env.SANGFOR_SPEC_ROOT;
  else process.env.SANGFOR_SPEC_ROOT = previousSpecRoot;
  rmSync(dir, { recursive: true, force: true });
});

describe('sangfor_collect_device_config — provenance wiring at the call site (issue #23 step 2/3)', () => {
  it('stamps the collection firmwareVersion into every observed fact envelope', async () => {
    const handler = getToolHandler('sangfor_collect_device_config')!;
    const poolPath = join(dir, 'pool.json');
    writeFileSync(poolPath, JSON.stringify({
      'POST /api/edrgoweb/v1/patch/statistics': { isLatest: true }
    }));
    const result = await handler({ product: 'EPP', version: '9.9.9', poolPath }) as {
      result?: { items: Array<{ id: string; verdict: string; observedSource?: { firmwareVersion?: string; transport?: string; mapperVersion?: string } }> };
      error?: string;
    };
    expect(result.error).toBeUndefined();
    const item = result.result!.items.find((entry) => entry.id === 'patch_latest')!;
    expect(item.verdict).toBe('PASS');
    expect(item.observedSource?.firmwareVersion).toBe('9.9.9');
    expect(item.observedSource?.transport).toBe('browser');
    expect(item.observedSource?.mapperVersion).toBeTruthy();
  });
});
