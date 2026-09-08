import type { SignedApproval } from '../../../packages/sangfor-operator/src/approval.js';
import type { RunRecord } from '../../../packages/sangfor-runs/src/index.js';
import { mintBridgeApproval, mintApproval } from './approval-mint.js';
import { ApiError } from './tower-contract.js';
import { assertLocalApprovalAuthorityAllowed } from './tower-authority-gate.js';
import type { TowerStores } from './tower-stores.js';
import type { BridgeRunner } from './tower-bridge-runner.js';
import type { PlaybookRunEngine } from './playbook-run-engine.js';

export interface ApprovalApiDeps {
  readonly stores: TowerStores;
  readonly bridge: BridgeRunner;
  readonly engine: PlaybookRunEngine;
  readonly originalArgs: Map<string, Record<string, unknown>>;
  readonly approvalSecret: string | undefined;
}

// pending_approval run의 승인·반려, 그리고 저장하지 않는 수동 승인 민팅(스펙 §6.4).
export function createApprovalApi(deps: ApprovalApiDeps) {
  const { stores: { store }, bridge, engine, originalArgs, approvalSecret } = deps;

  return {
    async approveRun(
      runId: string,
      input: { approvedBy: string; changeTicketId?: string; rollbackPlanId?: string },
    ): Promise<RunRecord> {
      assertLocalApprovalAuthorityAllowed();
      const record = store.getRun(runId);
      if (!record) throw new ApiError(404, `unknown run: ${runId}`);
      if (record.status !== 'pending_approval') throw new ApiError(409, `run is not pending_approval: ${record.status}`);
      if (!input.approvedBy?.trim()) throw new ApiError(400, 'approvedBy is required');
      if (!approvalSecret) throw new ApiError(500, 'approval secret not configured');
      let args = originalArgs.get(runId);
      if (!args) {
        // playbook write run은 재해석 폴백. 단일 도구 run은 기존대로 400 (마스킹본 실행 방지 · 무회귀).
        args = await engine.reinterpretBlockArgs(record);
      }
      const changeTicketId = input.changeTicketId?.trim() || `run:${runId}`;
      const rollbackPlanId = input.rollbackPlanId?.trim() || 'n/a-read-back-verify';
      const signed = mintBridgeApproval(record.toolId, {
        secret: approvalSecret, approvedBy: input.approvedBy, changeTicketId, rollbackPlanId, authorityEpoch: 0, ttlSec: 120,
      });
      await store.transition(runId, {
        status: 'running',
        approval: {
          approvedBy: input.approvedBy, approvedAt: new Date().toISOString(), changeTicketId, rollbackPlanId,
          authorityEpoch: signed.authorityEpoch,
        },
      });
      const final = await bridge.execute({ runId, toolId: record.toolId, args, approval: signed });
      originalArgs.delete(runId);
      // 접점 #2 (스펙 §5.3): 플레이북 write run이면 후속 블록을 이어서 실행. 실패한 write도
      // continueFromApprove에 들어가되 엔진이 실패를 재유도해 tool은 건너뛰고 report만 실행한다(→ partial/failed).
      if (record.playbookRunId) {
        await engine.continueFromApprove(record.playbookRunId);
        return store.getRun(runId) ?? final; // 승인된 write run 레코드를 그대로 반환
      }
      return final;
    },

    async rejectRun(runId: string, input: { reason?: string }): Promise<RunRecord> {
      assertLocalApprovalAuthorityAllowed();
      const record = store.getRun(runId);
      if (!record) throw new ApiError(404, `unknown run: ${runId}`);
      if (record.status !== 'pending_approval') throw new ApiError(409, `run is not pending_approval: ${record.status}`);
      if (!input.reason?.trim()) throw new ApiError(400, 'reason is required');
      originalArgs.delete(runId);
      return await store.transition(runId, { status: 'rejected', rejectedReason: input.reason.trim() });
    },

    // 스펙 §6.4: tool-args용 승인 수동 민팅 (HCI 등). 저장하지 않는다.
    mint(input: {
      actionType?: string; actionTarget?: string; approvedBy?: string;
      changeTicketId?: string; rollbackPlanId?: string; authorityEpoch?: number; ttlSec?: number;
    }): SignedApproval {
      if (!approvalSecret) throw new ApiError(500, 'approval secret not configured');
      for (const field of ['actionType', 'approvedBy', 'changeTicketId', 'rollbackPlanId'] as const) {
        if (!input[field] || !String(input[field]).trim()) throw new ApiError(400, `${field} is required`);
      }
      if (!Number.isInteger(input.authorityEpoch) || Number(input.authorityEpoch) < 0) throw new ApiError(400, 'authorityEpoch is required');
      return mintApproval({
        secret: approvalSecret,
        actionType: String(input.actionType),
        actionTarget: input.actionTarget ? String(input.actionTarget) : undefined,
        approvedBy: String(input.approvedBy),
        changeTicketId: String(input.changeTicketId),
        rollbackPlanId: String(input.rollbackPlanId),
        authorityEpoch: Number(input.authorityEpoch),
        ttlSec: typeof input.ttlSec === 'number' && input.ttlSec > 0 ? Math.min(input.ttlSec, 600) : undefined,
      });
    },
  };
}
