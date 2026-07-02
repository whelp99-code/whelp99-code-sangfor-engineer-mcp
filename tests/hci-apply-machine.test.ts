import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMockConsoleServer } from '../apps/mock-sangfor-console/src/server.js';
import { HciClient, KeystoneV2TokenProvider, AuditLedger, applyCreateVolume, listVolumes } from '@sangfor/hci-client';

let server: ReturnType<typeof createMockConsoleServer>;
let base = '';

beforeAll(async () => {
  server = createMockConsoleServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const mkClient = () => new HciClient(new KeystoneV2TokenProvider({
  identityBaseUrl: `${base}/openstack/identity/v2.0`,
  tenantName: 'lab', username: 'admin', password: 'mock-password',
}));
const fast = { pollIntervalMs: 1, maxPolls: 5 };

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'apply-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const ledger = () => new AuditLedger({ dir, secret: 'apply-secret' });

describe('applyCreateVolume state machine', () => {
  it('completes PENDING→…→SUCCEEDED with a PASS read-back, fully ledgered', async () => {
    const client = mkClient();
    const lg = ledger();
    const r = await applyCreateVolume(client, { name: 'am-ok', sizeGb: 4, clientToken: 'ct-am-ok' }, lg, fast);
    expect(r.ok).toBe(true);
    expect(r.finalState).toBe('SUCCEEDED');
    expect(r.readBack?.verdict).toBe('PASS');
    expect(r.events.map((e) => e.state)).toEqual(['PENDING', 'VALIDATING', 'APPLYING', 'VERIFYING', 'SUCCEEDED']);
    expect(lg.verify(r.runId)).toEqual({ ok: true, keyed: true });
  });

  it('halts (no rollback) when the server lies with a silent-noop 202', async () => {
    const client = mkClient();
    const r = await applyCreateVolume(client, { name: 'am-ghost', sizeGb: 9, clientToken: 'ct-am-ghost' }, ledger(), { ...fast, extraCreateHeaders: { 'x-mock-scenario': 'quota-silent-noop' } });
    expect(r.ok).toBe(false);
    expect(r.finalState).toBe('FAILED_HALT');
    expect(r.readBack?.verdict).toBe('FAIL');
  });

  it('is idempotent: same clientToken twice → exactly one volume', async () => {
    const client = mkClient();
    await applyCreateVolume(client, { name: 'am-idem', sizeGb: 2, clientToken: 'ct-am-idem' }, ledger(), fast);
    await applyCreateVolume(client, { name: 'am-idem', sizeGb: 2, clientToken: 'ct-am-idem' }, ledger(), fast);
    const dups = (await listVolumes(client)).filter((v) => v.name === 'am-idem');
    expect(dups).toHaveLength(1);
  });

  it('refuses invalid input before any HTTP call', async () => {
    const r = await applyCreateVolume(mkClient(), { name: '', sizeGb: 0, clientToken: 'x' }, ledger(), fast);
    expect(r.finalState).toBe('FAILED_HALT');
    expect(r.events.some((e) => e.state === 'APPLYING')).toBe(false);
  });
});
