import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

process.env.MCP_NO_SERVE = '1';

import { getToolHandler } from '../apps/mcp-server/src/index.js';
import { generateProductChangePlan } from '../packages/sangfor-product-adapters/src/index.js';

let evidenceRoot: string | undefined;

afterEach(() => {
  if (evidenceRoot) rmSync(evidenceRoot, { recursive: true, force: true });
  evidenceRoot = undefined;
  delete process.env.SANGFOR_EVIDENCE_ROOT;
});

describe('MCP product dry-run composition', () => {
  it('does not require a configured JM browser runtime without a session', async () => {
    evidenceRoot = mkdtempSync(join(tmpdir(), 'mcp-product-dry-run-'));
    process.env.SANGFOR_EVIDENCE_ROOT = evidenceRoot;
    const dryRun = getToolHandler('sangfor_dry_run_product_change');
    const plan = generateProductChangePlan({
      product: 'HCI_SCP',
      requirements: ['Enable DRS and verify HA status'],
    });

    await expect(dryRun?.({
      plan,
    })).resolves.toBeDefined();
  });
});
