import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordSnapshot } from '../packages/sangfor-chronicle/src/index.js';

// Importing the MCP server module must NOT start the stdio readline loop.
process.env.MCP_NO_SERVE = '1';

let getToolHandler: (name: string) => ((args: unknown) => unknown | Promise<unknown>) | undefined;
let listTools: () => Array<{ name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }>;
let dir: string;

beforeAll(async () => {
  const mcp = await import('../apps/mcp-server/src/index.js');
  getToolHandler = mcp.getToolHandler as typeof getToolHandler;
  listTools = mcp.listTools as typeof listTools;
  dir = mkdtempSync(join(tmpdir(), 'mcp-chronicle-'));
  recordSnapshot({ deviceId: 'fw-01', observed: { 'ntp.enabled': true }, capturedAt: '2026-08-18T10:00:00.000Z', dir });
  recordSnapshot({ deviceId: 'fw-01', observed: { 'ntp.enabled': false }, capturedAt: '2026-08-18T11:00:00.000Z', dir });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('sangfor_chronicle_diff — read-only chronicle surface (issue #23)', () => {
  it('is registered with an accurate read-only annotation', () => {
    const tool = listTools().find((t) => t.name === 'sangfor_chronicle_diff');
    expect(tool).toBeDefined();
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?.annotations?.destructiveHint).toBe(false);
  });

  it('returns the head diff for a device chain', async () => {
    const handler = getToolHandler('sangfor_chronicle_diff')!;
    const result = await handler({ deviceId: 'fw-01', dir }) as { deviceId: string; headHash: string; diff: Array<{ key: string }> };
    expect(result.deviceId).toBe('fw-01');
    expect(result.headHash).toBeTruthy();
    expect(result.diff.map((change) => change.key)).toContain('ntp.enabled');
  });

  it('reports an unknown device as an error object, never a fabricated diff', async () => {
    const handler = getToolHandler('sangfor_chronicle_diff')!;
    const result = await handler({ deviceId: 'no-such-device', dir }) as { error?: string };
    expect(result.error).toBeTruthy();
  });
});

describe('sangfor_drift_findings — unapproved-drift read model surface (issue #23)', () => {
  it('is registered with an accurate read-only annotation', () => {
    const tool = listTools().find((t) => t.name === 'sangfor_drift_findings');
    expect(tool).toBeDefined();
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?.annotations?.destructiveHint).toBe(false);
  });

  it('flags a diff with no matching approval and clears one covered by an approval window', async () => {
    const handler = getToolHandler('sangfor_drift_findings')!;
    const unapproved = await handler({ deviceId: 'fw-01', dir, approvals: [] }) as { findings: Array<{ type: string }> };
    expect(unapproved.findings.some((f) => f.type === 'unapproved-drift')).toBe(true);

    const approved = await handler({
      deviceId: 'fw-01', dir,
      approvals: [{ changeTicketId: 'CHG-1', deviceId: 'fw-01', approvedAt: '2026-08-18T10:30:00.000Z', windowEndAt: '2026-08-18T11:30:00.000Z' }]
    }) as { findings: unknown[] };
    expect(approved.findings).toHaveLength(0);
  });
});

describe('sangfor_collect_device_config — A5 minimal collection-load recording', () => {
  it('advertises collectionLoad in its result for a mapped pool', async () => {
    const handler = getToolHandler('sangfor_collect_device_config')!;
    const poolPath = join(dir, 'pool.json');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(poolPath, JSON.stringify({ product: 'ENDPOINT_SECURE', capturedAt: '2026-08-18T10:00:00.000Z', endpoints: [] }));
    const result = await handler({ product: 'EPP', version: '6.0.0', poolPath }) as {
      collectionLoad?: { apiCallCount: number; collectDurationMs: number }; error?: string;
    };
    // Whether or not a spec exists for this version, the load envelope must be present
    // on every non-refused mapping result; a refusal (error) must still carry it.
    expect(result.collectionLoad).toBeDefined();
    expect(result.collectionLoad!.apiCallCount).toBeGreaterThanOrEqual(0);
    expect(result.collectionLoad!.collectDurationMs).toBeGreaterThanOrEqual(0);
  });
});
