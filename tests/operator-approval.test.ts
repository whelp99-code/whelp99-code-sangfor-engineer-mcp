import { describe, it, expect } from 'vitest';
import {
  signApprovalToken,
  verifyExecutionApproval,
  type SignedApproval,
  type ApprovalActionRef,
} from '../packages/sangfor-operator/src/approval.js';

const SECRET = 'unit-test-approval-secret';

function makeApproval(
  action: ApprovalActionRef,
  overrides: Partial<Omit<SignedApproval, 'approvalToken'>> = {},
): SignedApproval {
  const base: Omit<SignedApproval, 'approvalToken'> = {
    approvedBy: 'change-manager@corp',
    changeTicketId: 'CHG-1001',
    rollbackPlanId: 'RBK-1001',
    nonce: 'nonce-abc',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
  return { ...base, approvalToken: signApprovalToken(SECRET, action, base) };
}

describe('verifyExecutionApproval — action-bound, time-bound, signed', () => {
  const action: ApprovalActionRef = { type: 'click', target: 'button#create-volume' };

  it('accepts a correctly signed, unexpired approval for the exact action', () => {
    const approval = makeApproval(action);
    expect(verifyExecutionApproval({ action, approval, secret: SECRET })).toEqual({ ok: true });
  });

  it('rejects a token signed for a DIFFERENT action (no cross-action replay)', () => {
    const approval = makeApproval({ type: 'click', target: 'button#delete-volume' });
    const result = verifyExecutionApproval({ action, approval, secret: SECRET });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/signature/i);
  });

  it('rejects an expired approval even if the signature is valid', () => {
    const approval = makeApproval(action, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    const result = verifyExecutionApproval({ action, approval, secret: SECRET });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/expired/i);
  });

  it('fails closed when the server secret is not configured', () => {
    const approval = makeApproval(action);
    const result = verifyExecutionApproval({ action, approval, secret: undefined });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/secret/i);
  });

  it('rejects when required approval fields are missing', () => {
    const approval = makeApproval(action);
    const result = verifyExecutionApproval({
      action,
      approval: { ...approval, changeTicketId: '' },
      secret: SECRET,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/missing/i);
  });

  it('rejects a tampered token (forged without the secret)', () => {
    const approval = makeApproval(action);
    const result = verifyExecutionApproval({
      action,
      approval: { ...approval, approvalToken: 'deadbeef' },
      secret: SECRET,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/signature/i);
  });
});
