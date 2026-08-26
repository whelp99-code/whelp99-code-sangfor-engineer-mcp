import {
  canonicalizeApprovalPayload,
  signDomainApproval,
  verifyDomainApprovalSignature,
} from '@sangfor/approval';
import { isLoopbackBrowserTarget } from '../../sangfor-browser-contracts/src/index.js';
import {
  resolveConfiguredWriteAuthority,
  type WriteAuthorityReferences,
} from '../../sangfor-competency/src/write-authority.js';
import {
  O1_NEGATIVE_CASE_CODES,
  resolveWriteEligibility,
  type IagBootstrapScope,
  type WriteEligibility,
} from '../../sangfor-safety/src/index.js';
import { consumeApprovalNonceAsync } from './nonce-store.js';
import { canonicalizeUrlOrigin, digestCanonicalOrigin } from '../../shared/src/index.js';
import { z } from 'zod';

const bootstrapApprovalSchema = z.object({
  approvedBy: z.string().min(1),
  approvalToken: z.string().regex(/^[a-f0-9]{64}$/u),
  changeTicketId: z.string().min(1),
  rollbackPlanId: z.string().min(1),
  purpose: z.string().min(1),
  nonce: z.string().min(1),
  expiresAt: z.string().min(1),
}).strict().readonly();

export type IagBootstrapApprovalFields = {
  readonly approvedBy: string;
  readonly changeTicketId: string;
  readonly rollbackPlanId: string;
  readonly purpose: string;
  readonly nonce: string;
  readonly expiresAt: string;
};

export type IagBootstrapApproval = IagBootstrapApprovalFields & {
  readonly approvalToken: string;
};

export type IagBootstrapAuthorizationInput = {
  readonly action: IagBootstrapScope;
  readonly authority: WriteAuthorityReferences;
  readonly approval: unknown;
  readonly now?: Date;
};

function canonicalBootstrapApproval(scope: IagBootstrapScope, approval: IagBootstrapApprovalFields): string {
  return canonicalizeApprovalPayload([
    'iag-evidence-bootstrap.v1', approval.approvedBy, approval.changeTicketId,
    approval.rollbackPlanId, approval.purpose, approval.nonce, approval.expiresAt,
    scope.product, scope.capabilityId, scope.actionKind, scope.targetEnvironment,
    scope.deviceId, scope.firmwareId, scope.windowId, scope.sessionId,
    scope.originId, scope.campaignId,
  ]);
}

export function signIagBootstrapApproval(
  secret: string,
  scope: IagBootstrapScope,
  approval: IagBootstrapApprovalFields,
): string {
  return Buffer.from(signDomainApproval(secret, canonicalBootstrapApproval(scope, approval))).toString('hex');
}

function refused(code: string): WriteEligibility {
  return { kind: 'REFUSED', code, promotionEligible: false };
}

type ParsedBootstrapInput = Omit<IagBootstrapAuthorizationInput, 'approval'> & { readonly approval: IagBootstrapApproval };

function verifyBootstrapApproval(input: ParsedBootstrapInput): WriteEligibility | undefined {
  const approvalSecret = process.env.SANGFOR_IAG_BOOTSTRAP_APPROVAL_SECRET;
  if (approvalSecret === undefined || approvalSecret.length === 0) return refused('IAG_BOOTSTRAP_APPROVAL_SECRET_REQUIRED');
  const approval = input.approval;
  const expiry = new Date(approval.expiresAt).getTime();
  if (Number.isNaN(expiry) || (input.now ?? new Date()).getTime() > expiry) return refused('IAG_BOOTSTRAP_APPROVAL_EXPIRED');
  const verdict = verifyDomainApprovalSignature(
    approvalSecret,
    canonicalBootstrapApproval(input.action, approval),
    Buffer.from(approval.approvalToken, 'hex'),
  );
  return verdict.ok ? undefined : refused('IAG_BOOTSTRAP_APPROVAL_SIGNATURE_REFUSED');
}

function exactAuthorityScope(
  action: IagBootstrapScope,
  scope: Exclude<Awaited<ReturnType<typeof resolveConfiguredWriteAuthority>>, { status: 'refused' }>['scope'],
  actionOriginDigest: string,
): boolean {
  return action.product === scope.product && action.capabilityId === scope.capabilityId
    && action.deviceId === scope.deviceId && action.firmwareId === scope.firmwareId
    && action.windowId === scope.windowId && action.sessionId === scope.sessionId
    && action.campaignId === scope.campaignId && actionOriginDigest === scope.originDigest;
}

/** Campaign-only high-level gate. No caller-authored maturity/evidence decision enters this boundary. */
export async function authorizeIagEvidenceBootstrap(input: IagBootstrapAuthorizationInput): Promise<WriteEligibility> {
  const parsedApproval = bootstrapApprovalSchema.safeParse(input.approval);
  if (!parsedApproval.success) return refused('IAG_BOOTSTRAP_APPROVAL_FIELDS_REQUIRED');
  const parsedInput: ParsedBootstrapInput = { ...input, approval: parsedApproval.data };
  let target: 'loopback' | 'non_loopback';
  let actionOriginDigest: string;
  try {
    const origin = canonicalizeUrlOrigin(parsedInput.action.originId, 'origin');
    actionOriginDigest = digestCanonicalOrigin(origin, 'origin');
    target = isLoopbackBrowserTarget(origin) ? 'loopback' : 'non_loopback';
  } catch {
    return refused('IAG_BOOTSTRAP_ORIGIN_REFUSED');
  }
  const bootstrapSecret = process.env.SANGFOR_IAG_BOOTSTRAP_APPROVAL_SECRET;
  if (bootstrapSecret !== undefined && [
    process.env.SANGFOR_OPERATOR_APPROVAL_SECRET,
    process.env.SANGFOR_CAPABILITY_PROMOTION_LEDGER_SECRET,
    process.env.SANGFOR_CAPABILITY_PROMOTION_CHECKPOINT_SECRET,
  ].includes(bootstrapSecret)) return refused('IAG_BOOTSTRAP_SECRET_DOMAIN_COLLISION');
  const authority = await resolveConfiguredWriteAuthority({
    references: parsedInput.authority,
    expected: { product: 'IAG', capabilityId: 'internet_policy', toolId: 'iag_o1_evidence_campaign', mode: 'bootstrap_mock' },
  });
  if (authority.status !== 'bootstrap_candidate' || !exactAuthorityScope(parsedInput.action, authority.scope, actionOriginDigest)) {
    return refused(authority.status === 'refused' ? authority.code : 'IAG_BOOTSTRAP_AUTHORITY_SCOPE_MISMATCH');
  }
  const preflight = resolveWriteEligibility({
    kind: 'iag_evidence_bootstrap', scope: parsedInput.action, maturity: 'tested_mock',
    mockEvidence: { status: 'completed_green', negativeCaseCodes: O1_NEGATIVE_CASE_CODES },
    activeEvidence: { status: 'unavailable' }, target,
    allowRealExecution: process.env.SANGFOR_ALLOW_REAL_EXECUTION === 'true',
    allowProductionExecution: process.env.SANGFOR_ALLOW_PRODUCTION_EXECUTION === 'true',
    approvalPurpose: parsedInput.approval.purpose,
  });
  if (preflight.kind === 'REFUSED') return preflight;
  const approvalRefusal = verifyBootstrapApproval(parsedInput);
  if (approvalRefusal !== undefined) return approvalRefusal;
  const consumed = await consumeApprovalNonceAsync(parsedInput.approval, parsedInput.now);
  return consumed.ok ? preflight : refused('IAG_BOOTSTRAP_NONCE_REFUSED');
}
