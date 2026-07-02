import { createHmac, timingSafeEqual } from 'node:crypto';

// ─── Signed, action-bound, time-bound live-execution approval ────────────────
//
// A live-execution approval is NOT a shared static token. It is an HMAC
// signature over the exact action plus an expiry and nonce, keyed by a
// server-side secret. This makes an approval:
//   - action-bound  (a token minted for `delete-volume` cannot authorize `create-volume`)
//   - time-bound     (expires; cannot be replayed indefinitely)
//   - unforgeable    (cannot be produced without the secret)
//   - constant-time verified (no timing oracle on the signature)
//
// Single-use enforcement lives in ./nonce-store (FileNonceStore) — a verified
// nonce is consumed durably, so replay of the same (action, nonce, expiresAt)
// tuple within its expiry window is rejected (closes redteam R1). Keep windows
// short regardless, so the store stays small and expired entries GC quickly.

export interface ApprovalActionRef {
  type: string;
  target?: string;
}

export interface SignedApproval {
  approvedBy: string;
  approvalToken: string; // hex HMAC-SHA256 signature
  changeTicketId: string;
  rollbackPlanId: string;
  nonce: string;
  expiresAt: string; // ISO 8601
}

export function approvalCanonicalString(
  action: ApprovalActionRef,
  approval: Omit<SignedApproval, 'approvalToken'>,
): string {
  return [
    approval.approvedBy,
    approval.changeTicketId,
    approval.rollbackPlanId,
    approval.nonce,
    approval.expiresAt,
    action.type,
    action.target ?? '',
  ].join('\n');
}

export function signApprovalToken(
  secret: string,
  action: ApprovalActionRef,
  approval: Omit<SignedApproval, 'approvalToken'>,
): string {
  return createHmac('sha256', secret).update(approvalCanonicalString(action, approval)).digest('hex');
}

export function verifyExecutionApproval(params: {
  action: ApprovalActionRef;
  approval: SignedApproval | undefined;
  secret: string | undefined;
  now?: Date;
}): { ok: boolean; reason?: string } {
  const { action, approval, secret } = params;
  const now = params.now ?? new Date();

  if (!secret) return { ok: false, reason: 'approval secret not configured (fail-closed)' };
  if (
    !approval?.approvedBy ||
    !approval.approvalToken ||
    !approval.changeTicketId ||
    !approval.rollbackPlanId ||
    !approval.nonce ||
    !approval.expiresAt
  ) {
    return { ok: false, reason: 'missing approval fields' };
  }

  const expiry = new Date(approval.expiresAt).getTime();
  if (Number.isNaN(expiry)) return { ok: false, reason: 'invalid expiresAt' };
  if (now.getTime() > expiry) return { ok: false, reason: 'approval expired' };

  const expected = signApprovalToken(secret, action, approval);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(approval.approvalToken, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'approval token signature mismatch' };
  }
  return { ok: true };
}
