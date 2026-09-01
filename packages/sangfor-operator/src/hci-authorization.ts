import { z } from 'zod';
import { isLoopbackBrowserTarget } from '../../sangfor-browser-contracts/src/index.js';
import {
  resolveConfiguredWriteAuthority,
  type WriteAuthorityReferences,
} from '../../sangfor-competency/src/write-authority.js';
import { getCapabilitySafety, resolveWriteEligibility, type WriteEligibility } from '../../sangfor-safety/src/index.js';
import { canonicalizeUrlOrigin, digestCanonicalOrigin } from '../../shared/src/index.js';
import { verifyExecutionApproval, type SignedApproval } from './approval.js';
import { consumeApprovalNonceAsync } from './nonce-store.js';

const signedApprovalSchema = z.object({
  approvedBy: z.string().min(1),
  approvalToken: z.string().min(1),
  changeTicketId: z.string().min(1),
  rollbackPlanId: z.string().min(1),
  nonce: z.string().min(1),
  expiresAt: z.string().min(1),
  authorityEpoch: z.number().int().nonnegative(),
}).strict().readonly();

export type HciMutationAuthorizationInput = {
  readonly action: {
    readonly kind: 'hci.create-volume' | 'hci.delete-volume';
    readonly target: string;
    readonly identityBaseUrl: string;
    readonly capabilityId: 'volume_create' | 'volume_delete';
  };
  readonly approval: unknown;
  readonly authority: WriteAuthorityReferences | undefined;
};

function refused(code: string): WriteEligibility {
  return { kind: 'REFUSED', code, promotionEligible: false };
}

function parseTarget(input: HciMutationAuthorizationInput): {
  readonly origin: string;
  readonly originDigest: string;
  readonly host: string;
  readonly loopback: boolean;
} | undefined {
  try {
    const origin = canonicalizeUrlOrigin(input.action.identityBaseUrl, 'url');
    const url = new URL(origin);
    if (!input.action.target.startsWith(`${url.hostname}:`)) return undefined;
    return { origin, originDigest: digestCanonicalOrigin(origin, 'origin'), host: url.hostname, loopback: isLoopbackBrowserTarget(origin) };
  } catch {
    return undefined;
  }
}

export async function authorizeHciMutation(input: HciMutationAuthorizationInput): Promise<WriteEligibility> {
  const target = parseTarget(input);
  if (target === undefined) return refused('HCI_CANONICAL_TARGET_REFUSED');
  const parsedApproval = signedApprovalSchema.safeParse(input.approval);
  const approval: SignedApproval | undefined = parsedApproval.success ? parsedApproval.data : undefined;
  const operatorSecret = process.env.SANGFOR_OPERATOR_APPROVAL_SECRET;
  if (operatorSecret !== undefined && [
    process.env.SANGFOR_CAPABILITY_PROMOTION_LEDGER_SECRET,
    process.env.SANGFOR_CAPABILITY_PROMOTION_CHECKPOINT_SECRET,
  ].includes(operatorSecret)) return refused('HCI_AUTHORITY_SECRET_DOMAIN_COLLISION');
  const verdict = verifyExecutionApproval({
    action: { type: input.action.kind, target: input.action.target },
    approval,
    secret: operatorSecret,
  });
  if (!verdict.ok || approval === undefined) return refused(`approval rejected: ${verdict.reason ?? 'missing approval fields'}`);

  let eligibility: WriteEligibility;
  if (target.loopback) {
    eligibility = resolveWriteEligibility({
      kind: 'ordinary', target: 'loopback',
      scope: {
        product: 'HCI_SCP', capabilityId: input.action.capabilityId, deviceId: target.host,
        firmwareId: 'mock', windowId: input.action.target, sessionId: input.action.target,
        originId: target.origin, campaignId: 'loopback-mock',
      },
      allowRealExecution: false, allowProductionExecution: false,
      safety: getCapabilitySafety('HCI_SCP', input.action.capabilityId),
      evidence: { status: 'unavailable' },
    });
  } else {
    if (input.authority === undefined) return refused('HCI_AUTHORITY_REFERENCES_REQUIRED');
    const authority = await resolveConfiguredWriteAuthority({
      references: input.authority,
      expected: {
        product: 'HCI_SCP', capabilityId: input.action.capabilityId,
        toolId: input.action.capabilityId === 'volume_create' ? 'sangfor_hci_apply_create_volume' : 'sangfor_hci_delete_volume',
        mode: 'ordinary_field',
      },
    });
    if (authority.status !== 'ordinary_active') {
      return refused(authority.status === 'refused' ? authority.code : 'HCI_ACTIVE_AUTHORITY_REQUIRED');
    }
    if (authority.scope.originDigest !== target.originDigest) return refused('HCI_AUTHORITY_ORIGIN_MISMATCH');
    const scope = { ...authority.scope, originId: authority.scope.originDigest };
    eligibility = resolveWriteEligibility({
      kind: 'ordinary', target: 'non_loopback', scope,
      allowRealExecution: process.env.SANGFOR_ALLOW_REAL_EXECUTION === 'true',
      allowProductionExecution: process.env.SANGFOR_ALLOW_PRODUCTION_EXECUTION === 'true',
      safety: getCapabilitySafety('HCI_SCP', input.action.capabilityId),
      evidence: { status: 'active', scope },
    });
  }
  if (eligibility.kind === 'REFUSED') return eligibility;
  const consumed = await consumeApprovalNonceAsync(approval);
  return consumed.ok ? eligibility : refused(`approval rejected: ${consumed.reason ?? 'nonce refused'}`);
}
