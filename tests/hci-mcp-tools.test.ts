import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Importing the MCP server module must NOT start the stdio loop.
process.env.MCP_NO_SERVE = '1';

import { createMockConsoleServer } from '../apps/mock-sangfor-console/src/server.js';
import { signApprovalToken } from '../packages/sangfor-operator/src/approval.js';
import { listTools, getToolHandler } from '../apps/mcp-server/src/index.js';

let server: ReturnType<typeof createMockConsoleServer>;
let base = '';
let identityBaseUrl = '';

beforeAll(async () => {
  server = createMockConsoleServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  identityBaseUrl = `${base}/openstack/identity/v2.0`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('hci mcp tools registration', () => {
  const byName = new Map(listTools().map((t: any) => [t.name, t]));
  it('registers 5 hci tools with correct annotations', () => {
    expect(byName.get('sangfor.hci_inventory')?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(byName.get('sangfor.hci_plan_create_volume')?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(byName.get('sangfor.hci_verify_volume')?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(byName.get('sangfor.hci_apply_create_volume')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(byName.get('sangfor.hci_delete_volume')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });
});

describe('hci apply tool gates (mock target, loopback)', () => {
  const SECRET = 'mcp-gate-secret';
  const saved = { ...process.env };
  let nonceDir: string;
  beforeEach(() => {
    nonceDir = mkdtempSync(join(tmpdir(), 'mcp-nonce-'));
    process.env.SANGFOR_OPERATOR_APPROVAL_SECRET = SECRET;
    process.env.SANGFOR_NONCE_STORE_PATH = join(nonceDir, 'nonces.json');
  });
  afterEach(() => {
    process.env = { ...saved };
    rmSync(nonceDir, { recursive: true, force: true });
  });

  const apply = getToolHandler('sangfor.hci_apply_create_volume')!;
  const mkApproval = (name: string) => {
    const base = {
      approvedBy: 'tester', changeTicketId: 'CHG-1', rollbackPlanId: 'RB-1',
      nonce: `n-${name}-${Math.round(performance.now() * 1000)}`,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    };
    return { ...base, approvalToken: signApprovalToken(SECRET, { type: 'hci.create-volume', target: `127.0.0.1:${name}` }, base) };
  };

  it('refuses without a signed approval', async () => {
    const r = await apply({ name: 'no-appr', sizeGb: 2, clientToken: 'ct-noappr-xyz', approval: {}, identityBaseUrl }) as any;
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/approval rejected/);
  });

  it('applies + verifies end-to-end with a valid approval', async () => {
    const approval = mkApproval('good-vol');
    const r = await apply({ name: 'good-vol', sizeGb: 3, clientToken: 'ct-good-vol-1', approval, identityBaseUrl }) as any;
    expect(r.ok).toBe(true);
    expect(r.finalState).toBe('SUCCEEDED');
  });

  it('refuses a replayed nonce', async () => {
    const approval = mkApproval('replay-vol');
    const first = await apply({ name: 'replay-vol', sizeGb: 2, clientToken: 'ct-replay-1', approval, identityBaseUrl }) as any;
    expect(first.ok).toBe(true);
    const second = await apply({ name: 'replay-vol', sizeGb: 2, clientToken: 'ct-replay-2', approval, identityBaseUrl }) as any;
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/already used/);
  });
});
