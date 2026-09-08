/**
 * Request, approval, and driver fixtures shared by the JM browser-port QA
 * scenarios.
 *
 * `baseRequest` and `approval` keep those exact call-site names because
 * `scripts/test-browser-port.ts#localReadBack` is pinned by the authority
 * census (`credential:scripts/test-browser-port.ts#localReadBack`), whose
 * digest covers that function's source text.
 */
import { randomUUID } from 'node:crypto';
import type { BrowserExecutionRequest } from '../../packages/sangfor-browser-contracts/src/index.js';
import type {
  JmBrowserDriver,
  LocalJmSession,
} from '../../packages/sangfor-jm-execution/src/index.js';
import {
  signApprovalToken,
  type ApprovalActionRef,
  type SignedApproval,
} from '../../packages/sangfor-operator/src/approval.js';

export function baseRequest(
  session: LocalJmSession,
  operation: BrowserExecutionRequest['operation'],
): BrowserExecutionRequest {
  return {
    schemaVersion: 'browser-execution-request.v1',
    requestId: `qa-${operation.kind}-${randomUUID()}`,
    sessionId: session.sessionId,
    origin: session.origin,
    operation,
  };
}

/** A driver that fails loudly if a refusal scenario ever reaches dispatch. */
export function noOpDriver(): JmBrowserDriver {
  return {
    async execute() {
      throw new Error('Driver must not execute for this refusal scenario.');
    },
    async closeSession() {},
  };
}

export function approval(
  secret: string,
  action: ApprovalActionRef,
): SignedApproval {
  const unsigned: Omit<SignedApproval, 'approvalToken'> = {
    approvedBy: 'ulw-browser-qa',
    changeTicketId: 'CHG-JM-BROWSER-QA',
    rollbackPlanId: 'RBK-JM-BROWSER-QA',
    nonce: randomUUID(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    authorityEpoch: 0,
  };
  return {
    ...unsigned,
    approvalToken: signApprovalToken(secret, action, unsigned),
  };
}
