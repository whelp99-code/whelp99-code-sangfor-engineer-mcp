import { randomBytes } from 'node:crypto';
import { signApprovalToken, type SignedApproval } from '../../../packages/sangfor-operator/src/approval.js';

// apps/http-bridge/src/tool-guard.ts의 BRIDGE_APPROVAL_ACTION_TYPE과 같은 값.
// 앱 간 직접 import를 피하려고 문자열을 복제한다 — 호환성은 T-INT-1이 실제 guard로 고정.
export const BRIDGE_APPROVAL_ACTION_TYPE = 'bridge.tool-call';

export interface MintInput {
  secret: string;
  actionType: string;
  actionTarget?: string;
  approvedBy: string;
  changeTicketId: string;
  rollbackPlanId: string;
  ttlSec?: number;
  now?: Date;
}

export function mintApproval(input: MintInput): SignedApproval {
  const now = input.now ?? new Date();
  const base = {
    approvedBy: input.approvedBy,
    changeTicketId: input.changeTicketId,
    rollbackPlanId: input.rollbackPlanId,
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
