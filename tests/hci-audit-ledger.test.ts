import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AuditLedger, maskSecrets } from '@sangfor/hci-client';

describe('maskSecrets', () => {
  it('masks secret-bearing keys recursively while preserving structure', () => {
    const masked = maskSecrets({
      auth: { passwordCredentials: { username: 'admin', password: 'Itac123!' } },
      headers: { 'x-auth-token': 'abc', accept: 'json' },
      nested: [{ apiSecret: 's' }],
    }) as any;
    expect(masked.auth.passwordCredentials.password).toBe('***');
    expect(masked.headers['x-auth-token']).toBe('***');
    expect(masked.nested[0].apiSecret).toBe('***');
    expect(masked.auth.passwordCredentials.username).toBe('admin');
  });
});

describe('AuditLedger', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ledger-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('appends masked entries and verifies the keyed chain', () => {
    const ledger = new AuditLedger({ dir, secret: 'ledger-secret' });
    ledger.append('run1', 'request', { op: 'create-volume', password: 'leak-me' });
    ledger.append('run1', 'response', { status: 202 });
    const raw = readFileSync(ledger.pathFor('run1'), 'utf8');
    expect(raw).not.toContain('leak-me');
    const v = ledger.verify('run1');
    expect(v).toEqual({ ok: true, keyed: true });
  });

  it('detects tampering', () => {
    const ledger = new AuditLedger({ dir, secret: 's' });
    ledger.append('run2', 'request', { a: 1 });
    ledger.append('run2', 'response', { b: 2 });
    const path = ledger.pathFor('run2');
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    const doctored = JSON.parse(lines[0]); doctored.payload = { a: 999 };
    writeFileSync(path, [JSON.stringify(doctored), lines[1]].join('\n') + '\n');
    const v = ledger.verify('run2');
    expect(v.ok).toBe(false);
    expect(v.brokenAt).toBe(0);
  });

  it('is honest about an unkeyed chain', () => {
    const ledger = new AuditLedger({ dir });
    ledger.append('run3', 'state', { s: 'PENDING' });
    expect(ledger.verify('run3').keyed).toBe(false);
  });
});
