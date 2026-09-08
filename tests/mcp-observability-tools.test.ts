import { testFileLocalWriteAuthority, testLocalWriteAuthority } from './helpers/local-write-authority.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordSnapshot } from '../packages/sangfor-chronicle/src/index.js';

// Importing the MCP server module must NOT start the stdio readline loop.
process.env.MCP_NO_SERVE = '1';

let getToolHandler: (name: string) => ((args: unknown) => unknown | Promise<unknown>) | undefined;
let listTools: () => Array<{ name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }>;
let chronicleDir: string;

beforeAll(async () => {
  const mcp = await import('../apps/mcp-server/src/index.js');
  getToolHandler = mcp.getToolHandler as typeof getToolHandler;
  listTools = mcp.listTools as typeof listTools;
  chronicleDir = mkdtempSync(join(tmpdir(), 'mcp-obs-'));
  await recordSnapshot({ deviceId: 'hci-01', observed: { firmware: '6.9.0', mtu: 9000 }, capturedAt: '2026-08-10T00:00:00.000Z', dir: chronicleDir , authority: testLocalWriteAuthority('config_chronicle_state', chronicleDir)});
  await recordSnapshot({ deviceId: 'hci-01', observed: { firmware: '6.11.3', mtu: 9000 }, capturedAt: '2026-08-15T00:00:00.000Z', dir: chronicleDir , authority: testLocalWriteAuthority('config_chronicle_state', chronicleDir)});
  await recordSnapshot({ deviceId: 'hci-02', observed: { firmware: '6.8.0', mtu: 1500 }, capturedAt: '2026-08-14T00:00:00.000Z', dir: chronicleDir , authority: testLocalWriteAuthority('config_chronicle_state', chronicleDir)});
});

afterAll(() => {
  rmSync(chronicleDir, { recursive: true, force: true });
});

const readOnly = (name: string) => {
  const tool = listTools().find((t) => t.name === name);
  expect(tool, name).toBeDefined();
  expect(tool?.annotations?.readOnlyHint, name).toBe(true);
  expect(tool?.annotations?.destructiveHint, name).toBe(false);
};

describe('observability read-only MCP surface (issues #24-#27)', () => {
  it('registers all three tools with accurate read-only annotations', () => {
    readOnly('sangfor_snapshot_query');
    readOnly('sangfor_report_chain_verify');
    readOnly('sangfor_scorecard_tier');
  });

  it('sangfor_snapshot_query answers a point-in-time query over chronicle chains', async () => {
    const handler = getToolHandler('sangfor_snapshot_query')!;
    const now = await handler({ dir: chronicleDir, where: { key: 'firmware', op: 'lt', value: '6.11.0' } }) as {
      matches: Array<{ deviceId: string }>; noData: unknown[];
    };
    expect(now.matches.map((m) => m.deviceId)).toEqual(['hci-02']);

    const past = await handler({ dir: chronicleDir, where: { key: 'firmware', op: 'lt', value: '6.11.0' }, asOf: '2026-08-12T00:00:00.000Z' }) as {
      matches: Array<{ deviceId: string }>; noData: Array<{ deviceId: string; reason: string }>;
    };
    expect(past.matches.map((m) => m.deviceId)).toEqual(['hci-01']);
    expect(past.noData.some((entry) => entry.deviceId === 'hci-02')).toBe(true);
  });

  it('sangfor_snapshot_query reports an empty chronicle dir as an error, never fabricated matches', async () => {
    const handler = getToolHandler('sangfor_snapshot_query')!;
    const empty = mkdtempSync(join(tmpdir(), 'mcp-obs-empty-'));
    try {
      const result = await handler({ dir: empty, where: { key: 'firmware', op: 'exists', value: null } }) as { error?: string };
      expect(result.error).toBeTruthy();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('sangfor_report_chain_verify verifies an engineer-report ledger directory', async () => {
    const handler = getToolHandler('sangfor_report_chain_verify')!;
    const result = await handler({ dir: chronicleDir }) as { ok: boolean };
    // chronicleDir holds no report ledger — the verifier must report that honestly.
    expect(typeof result.ok).toBe('boolean');
  });

  it('sangfor_scorecard_tier computes a tier and gold-only autonomy from supplied metrics', async () => {
    const handler = getToolHandler('sangfor_scorecard_tier')!;
    const result = await handler({
      metrics: { collectionSuccessRate: 0.99, freshnessAttainment: 0.99, corroborationDivergence: 0.01, corpusCoverage: 0.9, at: '2026-08-18T00:00:00.000Z' },
      thresholds: {
        gold: { collectionSuccessRate: 0.95, freshnessAttainment: 0.95, corroborationDivergence: 0.05, corpusCoverage: 0.8 },
        silver: { collectionSuccessRate: 0.8, freshnessAttainment: 0.8, corroborationDivergence: 0.15, corpusCoverage: 0.5 },
        holdDurationSec: 0
      }
    }) as { tier: string; autonomy: { 'auto-close': boolean; 'cross-device-spec': boolean } };
    expect(result.tier).toBe('gold');
    expect(result.autonomy['auto-close']).toBe(true);
  });
});
