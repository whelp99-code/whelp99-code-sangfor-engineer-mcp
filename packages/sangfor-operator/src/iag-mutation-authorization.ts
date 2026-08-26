import { createHash } from 'node:crypto';
import {
  canonicalizeApprovalPayload,
  signDomainApproval,
  verifyDomainApprovalSignature,
} from '@sangfor/approval';
import { isLoopbackBrowserTarget } from '../../sangfor-browser-contracts/src/index.js';
import { consumeApprovalNonceAsync } from './nonce-store.js';
import { z } from 'zod';

export const IAG_AUTHORIZATION_CLASSES = ['ordinary_active', 'bootstrap_candidate'] as const;
export type IagAuthorizationClass = (typeof IAG_AUTHORIZATION_CLASSES)[number];

const approvalSchema = z.object({
  approvedBy: z.string().min(1).max(256), approvalToken: z.string().regex(/^[a-f0-9]{64}$/u),
  changeTicketId: z.string().min(1).max(256), rollbackPlanId: z.string().min(1).max(256),
  purpose: z.enum(['ordinary_change', 'evidence_bootstrap']), nonce: z.string().min(1).max(256),
  expiresAt: z.string().datetime(), maintenanceWindow: z.string().min(1).max(256).optional(),
}).strict().readonly();
export type IagMutationApproval = z.infer<typeof approvalSchema>;
export type IagMutationApprovalFields = Omit<IagMutationApproval, 'approvalToken'>;
export type IagAuthorizationScope = {
  readonly actionDigest: string;
  readonly origin: string;
  readonly deviceIdentityDigest: string;
  readonly sessionId: string;
  readonly windowId: string;
};
export type IagAuthorizationResult =
  | { readonly ok: true; readonly approval: IagMutationApproval; readonly nonceRef: string }
  | { readonly ok: false; readonly code: string };

function canonical(scope: IagAuthorizationScope, approval: IagMutationApprovalFields): string {
  return canonicalizeApprovalPayload([
    'iag-complete-action.v1', approval.approvedBy, approval.changeTicketId,
    approval.rollbackPlanId, approval.purpose, approval.nonce, approval.expiresAt,
    approval.maintenanceWindow ?? '', scope.actionDigest, scope.origin,
    scope.deviceIdentityDigest, scope.sessionId, scope.windowId,
  ]);
}

export function signIagMutationApproval(
  secret: string,
  scope: IagAuthorizationScope,
  approval: IagMutationApprovalFields,
): string {
  return Buffer.from(signDomainApproval(secret, canonical(scope, approval))).toString('hex');
}

export function verifyIagMutationAuthorization(input: {
  readonly authorizationClass: IagAuthorizationClass;
  readonly scope: IagAuthorizationScope;
  readonly approval: unknown;
  readonly now: Date;
}): IagAuthorizationResult {
  const parsed = approvalSchema.safeParse(input.approval);
  if (!parsed.success) return { ok: false, code: 'APPROVAL_FIELDS_REQUIRED' };
  const approval = parsed.data;
  const expectedPurpose = input.authorizationClass === 'bootstrap_candidate'
    ? 'evidence_bootstrap' : 'ordinary_change';
  if (approval.purpose !== expectedPurpose) return { ok: false, code: 'APPROVAL_PURPOSE_REFUSED' };
  if (input.now.getTime() > Date.parse(approval.expiresAt)) return { ok: false, code: 'APPROVAL_EXPIRED' };
  if (process.env.SANGFOR_ALLOW_REAL_EXECUTION !== 'true') return { ok: false, code: 'REAL_EXECUTION_DISABLED' };
  if ((input.authorizationClass === 'bootstrap_candidate' || !isLoopbackBrowserTarget(input.scope.origin))
    && process.env.SANGFOR_ALLOW_PRODUCTION_EXECUTION !== 'true') {
    return { ok: false, code: 'PRODUCTION_EXECUTION_DISABLED' };
  }
  const secret = input.authorizationClass === 'bootstrap_candidate'
    ? process.env.SANGFOR_IAG_BOOTSTRAP_APPROVAL_SECRET
    : process.env.SANGFOR_OPERATOR_APPROVAL_SECRET;
  if (secret === undefined || secret.length < 1) return { ok: false, code: 'APPROVAL_SECRET_REQUIRED' };
  const collision = input.authorizationClass === 'bootstrap_candidate'
    && [process.env.SANGFOR_OPERATOR_APPROVAL_SECRET,
      process.env.SANGFOR_CAPABILITY_PROMOTION_LEDGER_SECRET,
      process.env.SANGFOR_CAPABILITY_PROMOTION_CHECKPOINT_SECRET].includes(secret);
  if (collision) return { ok: false, code: 'APPROVAL_SECRET_DOMAIN_COLLISION' };
  const verdict = verifyDomainApprovalSignature(
    secret, canonical(input.scope, approval), Buffer.from(approval.approvalToken, 'hex'),
  );
  if (!verdict.ok) return { ok: false, code: 'APPROVAL_SIGNATURE_REFUSED' };
  return {
    ok: true, approval,
    nonceRef: createHash('sha256').update(`iag-nonce\0${approval.nonce}`).digest('hex'),
  };
}

export async function consumeIagMutationNonce(
  approval: IagMutationApproval,
  now: Date,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: 'NONCE_REFUSED' }> {
  const consumed = await consumeApprovalNonceAsync(approval, now);
  return consumed.ok ? { ok: true } : { ok: false, code: 'NONCE_REFUSED' };
}
