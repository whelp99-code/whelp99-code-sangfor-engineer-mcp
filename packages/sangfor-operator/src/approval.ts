import {
  canonicalizeApprovalPayload,
  signDomainApproval,
  verifyDomainApprovalSignature,
} from '@sangfor/approval';

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
  value?: string;
  dryRun?: boolean;
  menuPath?: ReadonlyArray<{
    menu: string;
    submenu?: string;
  }>;
  formFields?: ReadonlyArray<{
    type: 'text' | 'password' | 'select' | 'checkbox' | 'textarea' | 'combobox' | 'radio';
    name?: string;
    id?: string;
    placeholder?: string;
    label?: string;
    value?: string;
    options?: readonly string[];
    index?: number;
  }>;
}

export interface SignedApproval {
  approvedBy: string;
  approvalToken: string; // hex HMAC-SHA256 signature
  changeTicketId: string;
  rollbackPlanId: string;
  nonce: string;
  expiresAt: string; // ISO 8601
  authorityEpoch: number;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, child]) =>
      `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
  }
  throw new Error('Approval action contains a non-JSON value.');
}

export function approvalCanonicalString(
  action: ApprovalActionRef,
  approval: Omit<SignedApproval, 'approvalToken'>,
): string {
  return canonicalizeApprovalPayload([
    approval.approvedBy,
    approval.changeTicketId,
    approval.rollbackPlanId,
    approval.nonce,
    approval.expiresAt,
    String(approval.authorityEpoch),
    canonicalJson(action),
  ]);
}

export function signApprovalToken(
  secret: string,
  action: ApprovalActionRef,
  approval: Omit<SignedApproval, 'approvalToken'>,
): string {
  return Buffer.from(signDomainApproval(secret, approvalCanonicalString(action, approval))).toString('hex');
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

  if (typeof approval.approvalToken !== 'string') {
    return { ok: false, reason: 'approval token signature mismatch' };
  }
  const verdict = verifyDomainApprovalSignature(
    secret,
    approvalCanonicalString(action, approval),
    Buffer.from(approval.approvalToken, 'hex'),
  );
  if (!verdict.ok) return { ok: false, reason: 'approval token signature mismatch' };
  return { ok: true };
}
