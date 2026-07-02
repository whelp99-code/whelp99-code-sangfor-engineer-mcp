import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  it('rejects the second consumption of the same nonce (replay)', () => {
    const store = new FileNonceStore(join(dir, 'nonces.json'));
    expect(store.consume('n1', future()).ok).toBe(true);
    const replay = store.consume('n1', future());
    expect(replay.ok).toBe(false);
    expect(replay.reason).toMatch(/already used/);
  });

  it('allows distinct nonces', () => {
    const store = new FileNonceStore(join(dir, 'nonces.json'));
    expect(store.consume('n1', future()).ok).toBe(true);
    expect(store.consume('n2', future()).ok).toBe(true);
  });

  it('garbage-collects expired records (an expired nonce may be re-consumed; expiry itself is rejected upstream)', () => {
    const path = join(dir, 'nonces.json');
    writeFileSync(path, JSON.stringify({ consumed: [{ nonce: 'old', expiresAt: new Date(Date.now() - 1000).toISOString(), consumedAt: new Date().toISOString() }] }));
    const store = new FileNonceStore(path);
    expect(store.consume('old', future()).ok).toBe(true);
  });

  it('fails closed when the store file is corrupt', () => {
    const path = join(dir, 'nonces.json');
    writeFileSync(path, 'not-json');
    const result = new FileNonceStore(path).consume('n1', future());
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/fail-closed/);
  });
});

describe('assertRealExecutionAllowed + nonce single-use', () => {
  let dir: string;
  const OLD = { ...process.env };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nonce-gate-'));
    process.env.SANGFOR_ALLOW_REAL_EXECUTION = 'true';
    process.env.SANGFOR_OPERATOR_APPROVAL_SECRET = 'test-secret';
    process.env.SANGFOR_NONCE_STORE_PATH = join(dir, 'nonces.json');
  });
  afterEach(() => {
    process.env = { ...OLD };
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects a verified approval when its nonce was already consumed', () => {
    const session = startOperatorSession({ mode: 'lab', product: 'HCI', targetUrl: 'https://10.80.1.9' });
    const action = { type: 'click', target: '#save', dryRun: false } as const;
    const base = { approvedBy: 'tester', changeTicketId: 'CHG-1', rollbackPlanId: 'RB-1', nonce: 'once-only', expiresAt: future() };
    const approval = { ...base, approvalToken: signApprovalToken('test-secret', { type: action.type, target: action.target }, base) };
    expect(() => assertRealExecutionAllowed(session, action as never, approval)).not.toThrow();
    expect(() => assertRealExecutionAllowed(session, action as never, approval)).toThrow(/already used/);
  });
});
