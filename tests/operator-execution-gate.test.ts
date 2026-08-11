import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  assertRealExecutionAllowed,
  type OperatorSession,
  type LiveExecutionApproval,
} from '../packages/sangfor-operator/src/index.js';
import {
  signApprovalToken,
  type ApprovalActionRef,
} from '../packages/sangfor-operator/src/approval.js';
import type { ConsoleAction } from '@sangfor/shared';

const SECRET = 'gate-test-secret';

function labSession(mode: OperatorSession['mode'] = 'lab'): OperatorSession {
  return { id: 'sess-1', product: 'HCI', mode, status: 'running' };
}

function liveAction(): ConsoleAction {
  return { type: 'click', target: 'button#create-volume', dryRun: false } as ConsoleAction;
}

function validApproval(action: ApprovalActionRef): LiveExecutionApproval {
  const base = {
    approvedBy: 'cm@corp',
    changeTicketId: 'CHG-9',
    rollbackPlanId: 'RBK-9',
    nonce: 'n-1',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  return { ...base, approvalToken: signApprovalToken(SECRET, action, base) };
}

describe('assertRealExecutionAllowed — live-execution gate failure branches', () => {
  const saved = { ...process.env };
  let nonceDir: string;
  beforeEach(() => {
    delete process.env.SANGFOR_ALLOW_REAL_EXECUTION;
    delete process.env.SANGFOR_ALLOW_PRODUCTION_EXECUTION;
    delete process.env.SANGFOR_OPERATOR_APPROVAL_SECRET;
    // Isolate the durable single-use nonce store so a fixed test nonce cannot
    // collide across runs (the store persists to data/runtime otherwise).
    nonceDir = mkdtempSync(join(tmpdir(), 'gate-nonce-'));
    process.env.SANGFOR_NONCE_STORE_PATH = join(nonceDir, 'nonces.json');
  });
  afterEach(() => {
    process.env = { ...saved };
    rmSync(nonceDir, { recursive: true, force: true });
  });

  it('is a no-op for dry-run actions (default safe path)', () => {
    const action = { type: 'click', target: 'x' } as ConsoleAction; // dryRun undefined
    expect(() => assertRealExecutionAllowed(labSession(), action, undefined)).not.toThrow();
  });

  it('blocks live execution when SANGFOR_ALLOW_REAL_EXECUTION is not set', () => {
    expect(() => assertRealExecutionAllowed(labSession(), liveAction(), undefined)).toThrow(/blocked/i);
  });

  it('blocks production live execution without SANGFOR_ALLOW_PRODUCTION_EXECUTION', () => {
    process.env.SANGFOR_ALLOW_REAL_EXECUTION = 'true';
    expect(() => assertRealExecutionAllowed(labSession('production'), liveAction(), undefined)).toThrow(/production/i);
  });

  it('rejects a missing/unsigned approval even when the real-execution flag is set', () => {
    process.env.SANGFOR_ALLOW_REAL_EXECUTION = 'true';
    process.env.SANGFOR_OPERATOR_APPROVAL_SECRET = SECRET;
    expect(() => assertRealExecutionAllowed(labSession(), liveAction(), undefined)).toThrow();
  });

  it('rejects an approval whose signature was minted for a different action', () => {
    process.env.SANGFOR_ALLOW_REAL_EXECUTION = 'true';
    process.env.SANGFOR_OPERATOR_APPROVAL_SECRET = SECRET;
    const otherAction = { type: 'click', target: 'button#delete-volume', dryRun: false } as ConsoleAction;
    const approval = validApproval(otherAction); // signed for delete, presented for create
    expect(() => assertRealExecutionAllowed(labSession(), liveAction(), approval)).toThrow(/signature/i);
  });

  it.each([
    ['value', { value: 'tampered-value' }],
    ['menuPath', { menuPath: [{ menu: 'Tampered menu' }] }],
    ['formFields', {
      formFields: [{ type: 'text' as const, label: 'Policy name', value: 'tampered-value' }],
    }],
  ])('binds approval to complete action field %s', (_field, override) => {
    process.env.SANGFOR_ALLOW_REAL_EXECUTION = 'true';
    process.env.SANGFOR_OPERATOR_APPROVAL_SECRET = SECRET;
    const approvedAction = {
      type: 'type',
      target: 'Policy name',
      value: 'approved-value',
      dryRun: false,
      menuPath: [{ menu: 'Policy', submenu: 'Access Control' }],
      formFields: [{ type: 'text' as const, label: 'Policy name', value: 'approved-value' }],
    } satisfies ApprovalActionRef;
    const approval = validApproval(approvedAction);

    expect(() => assertRealExecutionAllowed(
      labSession(),
      { ...approvedAction, ...override },
      approval,
    )).toThrow(/signature/i);
  });

  it('allows live execution with a correctly signed, unexpired approval', () => {
    process.env.SANGFOR_ALLOW_REAL_EXECUTION = 'true';
    process.env.SANGFOR_OPERATOR_APPROVAL_SECRET = SECRET;
    const action = liveAction();
    expect(() => assertRealExecutionAllowed(labSession(), action, validApproval(action))).not.toThrow();
  });

  it('does not consume a nonce when the signature gate fails first', () => {
    process.env.SANGFOR_ALLOW_REAL_EXECUTION = 'true';
    process.env.SANGFOR_OPERATOR_APPROVAL_SECRET = SECRET;
    const action = liveAction();
    const valid = validApproval(action);
    expect(() => assertRealExecutionAllowed(labSession(), action, { ...valid, approvalToken: '0'.repeat(64) }))
      .toThrow(/signature/i);
    expect(() => assertRealExecutionAllowed(labSession(), action, valid)).not.toThrow();
  });

  it('requires the production gate for any non-loopback mutation target', () => {
    process.env.SANGFOR_ALLOW_REAL_EXECUTION = 'true';
    process.env.SANGFOR_OPERATOR_APPROVAL_SECRET = SECRET;
    delete process.env.SANGFOR_ALLOW_PRODUCTION_EXECUTION;
    const action = liveAction();

    expect(() => assertRealExecutionAllowed(
      {
        ...labSession('lab'),
        targetUrl: 'https://production-device.example/admin',
      },
      action,
      validApproval(action),
    )).toThrow(/Production execution blocked/);
  });
});
