import { describe, expect, it } from 'vitest';
import { mintApproval, mintBridgeApproval, BRIDGE_APPROVAL_ACTION_TYPE } from '../apps/control-tower/src/approval-mint.js';
import { verifyExecutionApproval } from '../packages/sangfor-operator/src/approval.js';

const SECRET = 'mint-test-secret';

describe('approval-mint', () => {
  it('mintBridgeApproval 결과가 verifyExecutionApproval을 통과한다 (round-trip)', () => {
    const signed = mintBridgeApproval('sangfor.pm_create_engagement', {
      secret: SECRET, approvedBy: 'jmpark', changeTicketId: 'CHG-9', rollbackPlanId: 'RB-9',
    });
    expect(signed.nonce).toMatch(/^[0-9a-f]{24}$/); // randomBytes(12).hex
    const verdict = verifyExecutionApproval({
      action: { type: BRIDGE_APPROVAL_ACTION_TYPE, target: 'sangfor.pm_create_engagement' },
      approval: signed, secret: SECRET,
    });
    expect(verdict).toEqual({ ok: true });
  });

  it('다른 도구명(target)으로는 검증 실패 — action-bound', () => {
    const signed = mintBridgeApproval('tool.a', { secret: SECRET, approvedBy: 'a', changeTicketId: 'c', rollbackPlanId: 'r' });
    const verdict = verifyExecutionApproval({
      action: { type: BRIDGE_APPROVAL_ACTION_TYPE, target: 'tool.b' },
      approval: signed, secret: SECRET,
    });
    expect(verdict.ok).toBe(false);
  });

  it('기본 TTL 120초, now 주입 시 만료 판정 재현 가능', () => {
    const now = new Date('2026-07-03T00:00:00.000Z');
    const signed = mintApproval({
      secret: SECRET, actionType: 'hci.create-volume', actionTarget: 'h:vol',
      approvedBy: 'a', changeTicketId: 'c', rollbackPlanId: 'r', now,
    });
    expect(signed.expiresAt).toBe('2026-07-03T00:02:00.000Z');
    const late = verifyExecutionApproval({
      action: { type: 'hci.create-volume', target: 'h:vol' },
      approval: signed, secret: SECRET, now: new Date('2026-07-03T00:02:01.000Z'),
    });
    expect(late.ok).toBe(false);
    expect(late.reason).toMatch(/expired/);
  });
});
