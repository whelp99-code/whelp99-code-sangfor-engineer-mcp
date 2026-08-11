import { describe, it, expect } from 'vitest';
import {
  approvalCanonicalString,
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

  it('canonicalizes the complete action as stable JSON and accepts uppercase hex tokens', () => {
    const approval = makeApproval(action);
    expect(approvalCanonicalString(action, approval)).toBe([
      approval.approvedBy,
      approval.changeTicketId,
      approval.rollbackPlanId,
      approval.nonce,
      approval.expiresAt,
      '{"target":"button#create-volume","type":"click"}',
    ].join('\n'));
    expect(verifyExecutionApproval({
      action,
      approval: { ...approval, approvalToken: approval.approvalToken.toUpperCase() },
      secret: SECRET,
    })).toEqual({ ok: true });
  });

  it('treats malformed/odd-length hex tokens as a signature mismatch (legacy Buffer.from semantics)', () => {
    const approval = makeApproval(action);
    // Odd-length hex: Buffer.from('abc', 'hex') yields a single byte -> length mismatch.
    expect(verifyExecutionApproval({
      action,
      approval: { ...approval, approvalToken: 'abc' },
      secret: SECRET,
    }).reason).toMatch(/signature/i);
    // Non-hex characters decode to zero bytes -> mismatch, not an encoding error.
    expect(verifyExecutionApproval({
      action,
      approval: { ...approval, approvalToken: 'z'.repeat(64) },
      secret: SECRET,
    }).reason).toMatch(/signature/i);
  });

  it('treats now === expiresAt as still valid and +1ms as expired (boundary)', () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const approval = makeApproval(action, { expiresAt });
    const atExpiry = new Date(expiresAt);
    expect(verifyExecutionApproval({ action, approval, secret: SECRET, now: atExpiry })).toEqual({ ok: true });
    const justAfter = verifyExecutionApproval({ action, approval, secret: SECRET, now: new Date(atExpiry.getTime() + 1) });
    expect(justAfter.ok).toBe(false);
    expect(justAfter.reason).toMatch(/expired/i);
  });
});
