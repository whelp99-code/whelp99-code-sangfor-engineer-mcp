import type { ConsoleAction } from '../../shared/src/index.js';
import { isLoopbackBrowserTarget } from '../../sangfor-browser-contracts/src/index.js';
import { verifyExecutionApproval } from './approval.js';
import { consumeApprovalNonceAsync } from './nonce-store.js';
import type { ApprovalActionRef } from './approval.js';
import type { LiveExecutionApproval, OperatorSession } from './types.js';

export function verifyRealExecutionAllowed(
  session: OperatorSession,
  action: ApprovalActionRef,
  approval?: LiveExecutionApproval,
): void {
  if (action.dryRun !== false) return;
  if (process.env.SANGFOR_ALLOW_REAL_EXECUTION !== 'true') {
    throw new Error('Live execution blocked. Set SANGFOR_ALLOW_REAL_EXECUTION=true only in an authorized lab/customer session.');
  }
  const requiresProductionGate = session.mode === 'production'
    || (session.targetUrl !== undefined
      && !isLoopbackBrowserTarget(session.targetUrl));
  if (requiresProductionGate && process.env.SANGFOR_ALLOW_PRODUCTION_EXECUTION !== 'true') {
    throw new Error('Production execution blocked. Set SANGFOR_ALLOW_PRODUCTION_EXECUTION=true only after formal change approval.');
  }
  const verdict = verifyExecutionApproval({
    action,
    approval,
    secret: process.env.SANGFOR_OPERATOR_APPROVAL_SECRET,
  });
  if (!verdict.ok) throw new Error(`Live execution approval rejected: ${verdict.reason}.`);
}

// Asynchronous because the selected nonce store may be the database (see
// nonce-store.ts). The consumption stays the LAST step of the gate so a call
// refused for any other reason never burns a single-use approval.
export async function consumeRealExecutionApprovalNonce(
  action: ApprovalActionRef,
  approval?: LiveExecutionApproval,
): Promise<void> {
  if (action.dryRun !== false) return;
  if (!approval) throw new Error('Live execution approval rejected: missing approval fields.');
  const consumed = await consumeApprovalNonceAsync({
    nonce: approval.nonce,
    expiresAt: approval.expiresAt,
    authorityEpoch: approval.authorityEpoch,
  });
  if (!consumed.ok) throw new Error(`Live execution approval rejected: ${consumed.reason}.`);
}

export async function assertRealExecutionAllowed(
  session: OperatorSession,
  action: ApprovalActionRef,
  approval?: LiveExecutionApproval,
): Promise<void> {
  verifyRealExecutionAllowed(session, action, approval);
  await consumeRealExecutionApprovalNonce(action, approval);
}

export function assertNavigationWithinTarget(
  session: { targetUrl?: string },
  action: { type: string; target?: string },
): void {
  if (action.type !== 'navigate' || !action.target) return;
  if (!session.targetUrl) throw new Error('navigate requires a session targetUrl.');
  const origin = new URL(session.targetUrl);
  const target = new URL(action.target, origin);
  if (target.origin !== origin.origin) {
    throw new Error(`navigate blocked: ${target.origin} is outside the session origin ${origin.origin} (fail-closed).`);
  }
}
