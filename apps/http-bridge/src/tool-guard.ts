import { verifyExecutionApproval, type SignedApproval } from '../../../packages/sangfor-operator/src/approval.js';
import { consumeApprovalNonce } from '../../../packages/sangfor-operator/src/nonce-store.js';

type ToolListResult = {
  tools?: Array<{
    name?: unknown;
    annotations?: {
      readOnlyHint?: unknown;
      destructiveHint?: unknown;
    };
  }>;
};

export function findToolAnnotations(toolListResult: unknown, name: string) {
  const tools = (toolListResult as ToolListResult)?.tools;
  if (!Array.isArray(tools)) return null;
  const tool = tools.find((entry) => entry.name === name);
  const annotations = tool?.annotations;
  if (
    typeof annotations?.readOnlyHint !== 'boolean' ||
    typeof annotations.destructiveHint !== 'boolean'
  ) {
    return null;
  }
  return annotations;
}

export function isToolAllowedByAnnotations(toolListResult: unknown, name: string): boolean {
  const annotations = findToolAnnotations(toolListResult, name);
  return annotations?.readOnlyHint === true && annotations.destructiveHint === false;
}

export interface ToolAuthDecision {
  allow: boolean;
  status?: number;
  error?: string;
}

export const BRIDGE_APPROVAL_ACTION_TYPE = 'bridge.tool-call';

/**
 * Single source of truth for whether an incoming /tools/call is authorized.
 * Invariants (regression-pinned):
 *  - unknown/missing annotations  → refuse (fail-closed), approval cannot bypass this
 *  - destructiveHint              → refuse ALWAYS, even with the whitelist off
 *  - write tool on a remote bind  → refuse unless allowRemoteWrite is explicit (redteam R3),
 *                                   even with a valid approval
 *  - non-read-only ("write") tool → refuse unless the whitelist is explicitly disabled
 *  - read-only tool               → allow
 * Signed-approval path (control tower):
 *  - a SignedApproval bound to {type:'bridge.tool-call', target:<tool name>} that verifies
 *    against the server-side secret permits write AND destructive tools for this one call.
 *  - the nonce is consumed LAST, immediately before allow — a refused call must not burn
 *    a single-use approval.
 */
export function authorizeToolCall(params: {
  name: string;
  toolListResult: unknown;
  enforceWhitelist: boolean;
  remoteBind?: boolean;        // bridge is bound beyond loopback
  allowRemoteWrite?: boolean;  // SANGFOR_ALLOW_REMOTE_WRITE === 'true'
  approval?: SignedApproval;   // signed, action-bound, single-use (control tower)
  approvalSecret?: string;     // SANGFOR_OPERATOR_APPROVAL_SECRET
}): ToolAuthDecision {
  const {
    name, toolListResult, enforceWhitelist,
    remoteBind = false, allowRemoteWrite = false,
    approval, approvalSecret,
  } = params;
  const annotations = findToolAnnotations(toolListResult, name);
  if (!annotations) {
    return { allow: false, status: 403, error: `Tool annotations unavailable; refusing call: ${name}` };
  }
  const isWrite = annotations.readOnlyHint !== true;
  if (approval) {
    const verdict = verifyExecutionApproval({
      action: { type: BRIDGE_APPROVAL_ACTION_TYPE, target: name },
      approval,
      secret: approvalSecret,
    });
    if (!verdict.ok) {
      return { allow: false, status: 403, error: `bridge approval rejected: ${verdict.reason}` };
    }
    if (isWrite && remoteBind && !allowRemoteWrite) {
      return { allow: false, status: 403, error: `Write tool refused on a remote (non-loopback) bind: ${name}. Set SANGFOR_ALLOW_REMOTE_WRITE=true only for an authorized deployment.` };
    }
    const consumed = consumeApprovalNonce({ nonce: approval.nonce, expiresAt: approval.expiresAt });
    if (!consumed.ok) {
      return { allow: false, status: 403, error: `bridge approval rejected: ${consumed.reason}` };
    }
    return { allow: true };
  }
  if (annotations.destructiveHint) {
    return { allow: false, status: 403, error: `Destructive tool refused by MCP annotations: ${name}` };
  }
  if (isWrite && remoteBind && !allowRemoteWrite) {
    return { allow: false, status: 403, error: `Write tool refused on a remote (non-loopback) bind: ${name}. Set SANGFOR_ALLOW_REMOTE_WRITE=true only for an authorized deployment.` };
  }
  if (enforceWhitelist && !isToolAllowedByAnnotations(toolListResult, name)) {
    return { allow: false, status: 403, error: `Tool is not annotated read-only: ${name}` };
  }
  return { allow: true };
}
