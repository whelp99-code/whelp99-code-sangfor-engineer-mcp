import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.MCP_NO_SERVE = '1';

import { createMockConsoleServer } from '../apps/mock-sangfor-console/src/server.js';
import { signApprovalToken } from '../packages/sangfor-operator/src/approval.js';
import { getToolHandler } from '../apps/mcp-server/src/index.js';
import {
  HciClient, KeystoneV2TokenProvider, AuditLedger, applyCreateVolume, getVolume,
} from '@sangfor/hci-client';

// M1 Exit Criteria, exercised end-to-end at the MCP-handler level (no human in the loop):
//  (1) idempotent apply — same clientToken never duplicates
//  (2) the documented 202-silent-noop halts (read-back FAIL), never false-passes
//  (3) apply -> read-back verify -> restore (delete) completes with zero human steps
//  (4) every step is on a keyed, masked audit ledger
//  (5) read-back != intent auto-halts (false-pass = 0)
//  + a replayed approval nonce is refused

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

const SECRET = 'e2e-approval-secret';
const LEDGER_SECRET = 'e2e-ledger-secret';
const fast = { pollIntervalMs: 1, maxPolls: 8 };
const saved = { ...process.env };
let nonceDir: string;

beforeEach(() => {
  nonceDir = mkdtempSync(join(tmpdir(), 'e2e-nonce-'));
  process.env.SANGFOR_OPERATOR_APPROVAL_SECRET = SECRET;
  process.env.SANGFOR_CHANGE_LEDGER_SECRET = LEDGER_SECRET;
  process.env.SANGFOR_NONCE_STORE_PATH = join(nonceDir, 'nonces.json');
});
afterEach(() => {
  process.env = { ...saved };
  rmSync(nonceDir, { recursive: true, force: true });
});

const mkClient = () => new HciClient(new KeystoneV2TokenProvider({
  identityBaseUrl, tenantName: 'lab', username: 'admin', password: 'mock-password',
}));

let nonceCounter = 0;
const approvalFor = (type: 'hci.create-volume' | 'hci.delete-volume', target: string) => {
  nonceCounter += 1;
  const b = {
    approvedBy: 'e2e', changeTicketId: 'CHG-e2e', rollbackPlanId: 'RB-e2e',
    nonce: `e2e-${nonceCounter}`, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  };
  return { ...b, approvalToken: signApprovalToken(SECRET, { type, target }, b) };
};

describe('M1 vertical slice — plan → apply → verify → restore, hands-off', () => {
  it('runs the full lifecycle and pins every exit criterion', async () => {
    const plan = getToolHandler('sangfor.hci_plan_create_volume')!;
    const apply = getToolHandler('sangfor.hci_apply_create_volume')!;
    const verify = getToolHandler('sangfor.hci_verify_volume')!;
    const del = getToolHandler('sangfor.hci_delete_volume')!;
    const inventory = getToolHandler('sangfor.hci_inventory')!;

    // 1) plan — no mutation, mints the idempotency token
    const planned = await plan({ name: 'e2e-vol', sizeGb: 5, identityBaseUrl }) as any;
    expect(planned.mutationPerformed).toBe(false);
    expect(planned.clientToken).toMatch(/^cv-/);

    // 2+3) apply with a valid signed approval → SUCCEEDED via read-back
    const applied = await apply({
      name: 'e2e-vol', sizeGb: 5, clientToken: planned.clientToken,
      approval: approvalFor('hci.create-volume', '127.0.0.1:e2e-vol'), identityBaseUrl,
    }) as any;
    expect(applied.ok).toBe(true);
    expect(applied.finalState).toBe('SUCCEEDED');
    expect(applied.readBack.verdict).toBe('PASS');
    const volumeId = applied.volumeId as string;

    // Exit (1): same clientToken again → no duplicate volume
    const applied2 = await apply({
      name: 'e2e-vol', sizeGb: 5, clientToken: planned.clientToken,
      approval: approvalFor('hci.create-volume', '127.0.0.1:e2e-vol'), identityBaseUrl,
    }) as any;
    expect(applied2.ok).toBe(true);
    const inv = await inventory({ identityBaseUrl }) as any;
    expect(inv.volumes.filter((v: any) => v.name === 'e2e-vol')).toHaveLength(1);

    // Exit (2)+(5): the documented 202-silent-noop must HALT, never PASS
    const halt = await applyCreateVolume(mkClient(), { name: 'e2e-ghost', sizeGb: 9, clientToken: 'ct-e2e-ghost' }, new AuditLedger(), { ...fast, extraCreateHeaders: { 'x-mock-scenario': 'quota-silent-noop' } });
    expect(halt.finalState).toBe('FAILED_HALT');
    expect(halt.readBack?.verdict).toBe('FAIL');

    // 6) standalone read-back verification PASSes for the real volume
    const verified = await verify({ volumeId, name: 'e2e-vol', sizeGb: 5, identityBaseUrl }) as any;
    expect(verified.verdict).toBe('PASS');

    // Exit (3): restore — delete the volume, then confirm it is gone (404)
    const deleted = await del({ volumeId, approval: approvalFor('hci.delete-volume', `127.0.0.1:${volumeId}`), identityBaseUrl }) as any;
    expect(deleted.ok).toBe(true);
    const client = mkClient();
    let gone = false;
    for (let i = 0; i < 5 && !gone; i += 1) gone = (await getVolume(client, volumeId)) === null;
    expect(gone).toBe(true);

    // Exit (4): the apply run is on a keyed, tamper-evident ledger, and no secret leaked
    const ledger = new AuditLedger({ secret: LEDGER_SECRET });
    expect(ledger.verify(applied.runId)).toEqual({ ok: true, keyed: true });
    expect(readFileSync(applied.ledger as string, 'utf8')).not.toContain('mock-password');
  });

  it('refuses a replayed approval nonce (single-use)', async () => {
    const apply = getToolHandler('sangfor.hci_apply_create_volume')!;
    const approval = approvalFor('hci.create-volume', '127.0.0.1:replay');
    const first = await apply({ name: 'replay', sizeGb: 2, clientToken: 'ct-replay-a1', approval, identityBaseUrl }) as any;
    expect(first.ok).toBe(true);
    const second = await apply({ name: 'replay', sizeGb: 2, clientToken: 'ct-replay-a2', approval, identityBaseUrl }) as any;
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/already used/);
  });
});
