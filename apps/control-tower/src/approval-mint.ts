import { randomBytes } from 'node:crypto';
import { signApprovalToken, type SignedApproval } from '../../../packages/sangfor-operator/src/approval.js';
import { BRIDGE_APPROVAL_ACTION_TYPE } from '../../../packages/sangfor-operator/src/tool-authorization.js';

export interface MintInput {
  secret: string;
  actionType: string;
  actionTarget?: string;
  approvedBy: string;
  changeTicketId: string;
  rollbackPlanId: string;
  authorityEpoch: number;
  ttlSec?: number;
  now?: Date;
}

export function mintApproval(input: MintInput): SignedApproval {
  const now = input.now ?? new Date();
  const base = {
    approvedBy: input.approvedBy,
    changeTicketId: input.changeTicketId,
    rollbackPlanId: input.rollbackPlanId,
    authorityEpoch: input.authorityEpoch,
    nonce: randomBytes(12).toString('hex'),
    expiresAt: new Date(now.getTime() + (input.ttlSec ?? 120) * 1000).toISOString(),
  };
  return {
    ...base,
    approvalToken: signApprovalToken(input.secret, { type: input.actionType, target: input.actionTarget }, base),
  };
}

export function mintBridgeApproval(
  toolId: string,
  input: Omit<MintInput, 'actionType' | 'actionTarget'>,
): SignedApproval {
  return mintApproval({ ...input, actionType: BRIDGE_APPROVAL_ACTION_TYPE, actionTarget: toolId });
}
