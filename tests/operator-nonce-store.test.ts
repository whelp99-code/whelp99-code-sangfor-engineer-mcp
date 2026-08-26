import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileNonceStore } from '../packages/sangfor-operator/src/nonce-store.js';
import { signApprovalToken } from '../packages/sangfor-operator/src/approval.js';
import { assertRealExecutionAllowed, startOperatorSession } from '@sangfor/operator';

const future = () => new Date(Date.now() + 5 * 60_000).toISOString();

describe('FileNonceStore', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'nonce-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('rejects the second consumption of the same nonce (replay)', async () => {
    const store = new FileNonceStore(join(dir, 'nonces.json'));
    expect((await store.consume('n1', future())).ok).toBe(true);
    const replay = await store.consume('n1', future());
    expect(replay.ok).toBe(false);
    expect(replay.reason).toMatch(/already used/);
  });

  it('allows distinct nonces', async () => {
    const store = new FileNonceStore(join(dir, 'nonces.json'));
    expect((await store.consume('n1', future())).ok).toBe(true);
    expect((await store.consume('n2', future())).ok).toBe(true);
  });

  it('garbage-collects expired records (an expired nonce may be re-consumed; expiry itself is rejected upstream)', async () => {
    const path = join(dir, 'nonces.json');
    writeFileSync(path, JSON.stringify({ consumed: [{ nonce: 'old', expiresAt: new Date(Date.now() - 1000).toISOString(), consumedAt: new Date().toISOString() , authorityEpoch: 0}] }));
    const store = new FileNonceStore(path);
    expect((await store.consume('old', future())).ok).toBe(true);
  });

  it('fails closed when the store file is corrupt', async () => {
    const path = join(dir, 'nonces.json');
    writeFileSync(path, 'not-json');
    const result = await new FileNonceStore(path).consume('n1', future());
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/fail-closed/);
  });

  it('keeps operator error meaning while using the shared lock and 0600 store', async () => {
    const path = join(dir, 'locked.json');
    const store = new FileNonceStore(path);
    expect((await store.consume('n1', future())).ok).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    mkdirSync(`${path}.lock`, { mode: 0o700 });
    const result = await store.consume('n2', future());
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/nonce store unavailable \(fail-closed\)/);
    expect(result.reason).toMatch(/NONCE_STORE_LOCK_TIMEOUT/);
  });
});

describe('assertRealExecutionAllowed + nonce single-use', () => {
  let dir: string;
  const OLD = { ...process.env };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nonce-gate-'));
    process.env.SANGFOR_ALLOW_REAL_EXECUTION = 'true';
    process.env.SANGFOR_ALLOW_PRODUCTION_EXECUTION = 'true';
    process.env.SANGFOR_OPERATOR_APPROVAL_SECRET = 'test-secret';
    process.env.SANGFOR_NONCE_STORE_PATH = join(dir, 'nonces.json');
  });
  afterEach(() => {
    process.env = { ...OLD };
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects a verified approval when its nonce was already consumed', async () => {
    const session = startOperatorSession({ mode: 'lab', product: 'HCI', targetUrl: 'https://10.80.1.9' });
    const action = { type: 'click', target: '#save', dryRun: false } as const;
    const base = { approvedBy: 'tester', changeTicketId: 'CHG-1', rollbackPlanId: 'RB-1', nonce: 'once-only', expiresAt: future() , authorityEpoch: 0};
    const approval = { ...base, approvalToken: signApprovalToken('test-secret', action, base) };
    await expect(assertRealExecutionAllowed(session, action, approval))
      .resolves.toBeUndefined();
    await expect(assertRealExecutionAllowed(session, action, approval))
      .rejects.toThrow(/already used/);
  });
});
