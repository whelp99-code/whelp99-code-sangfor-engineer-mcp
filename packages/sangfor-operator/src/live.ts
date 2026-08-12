import { requiresApprovalForAction } from '@sangfor/approval';
import {
  browserExecutionRequestSchema,
  isAuthoritativePass,
  type BrowserExecutionPort,
} from '../../sangfor-browser-contracts/src/index.js';
import type { ConsoleActionResult } from '../../shared/src/index.js';
import { nowId } from '../../shared/src/index.js';
import {
  assertNavigationWithinTarget,
  consumeRealExecutionApprovalNonce,
  verifyRealExecutionAllowed,
} from './gate.js';
import { getOperatorSession, readConsoleState } from './session.js';
import type { LiveConsoleActionInput } from './types.js';

export async function readLiveConsoleState(input: {
  sessionId: string;
  executionPort?: BrowserExecutionPort;
}): Promise<Record<string, unknown>> {
  const session = getOperatorSession(input.sessionId);
  if (session.mode === 'mock') return readConsoleState(input.sessionId);
  if (!session.targetUrl) throw new Error('Live console state requires targetUrl.');
  if (!input.executionPort) throw new Error('BROWSER_EXECUTION_PORT_REQUIRED: live read requires JM runtime composition.');
  const result = await input.executionPort.execute({
    schemaVersion: 'browser-execution-request.v1',
    requestId: nowId('browser-read'),
    sessionId: input.sessionId,
    origin: new URL(session.targetUrl).origin,
    operation: { kind: 'observe_console', includeSnapshot: true },
  });
  if (!isAuthoritativePass(result)) {
    throw new Error(result.error?.message ?? `Live read failed: ${result.status}`);
  }
  return {
    sessionId: input.sessionId,
    mode: session.mode,
    ...(result.observations ?? {}),
    screenshotPath: result.evidence[0]?.artifactRef,
    browser: 'jm-local-port',
    product: session.product,
  };
}

export async function executeLiveConsoleAction(
  input: LiveConsoleActionInput,
): Promise<ConsoleActionResult> {
  const session = getOperatorSession(input.sessionId);
  const action = { ...input.action, dryRun: input.action.dryRun !== false };
  const approval = requiresApprovalForAction(action);
  const approvalAction = {
    ...action,
    ...(input.menuPath === undefined ? {} : { menuPath: input.menuPath }),
    ...(input.formFields === undefined ? {} : { formFields: input.formFields }),
  };
  if (!session.targetUrl) throw new Error('Live execution requires targetUrl.');
  if (!input.executionPort) throw new Error('BROWSER_EXECUTION_PORT_REQUIRED: live action requires JM runtime composition.');
  assertNavigationWithinTarget(session, action);
  verifyRealExecutionAllowed(session, approvalAction, input.approval);
  const actionRequest = browserExecutionRequestSchema.parse({
    schemaVersion: 'browser-execution-request.v1',
    requestId: nowId('browser-action'),
    sessionId: input.sessionId,
    origin: new URL(session.targetUrl).origin,
    operation: {
      kind: 'perform_console_action',
      action,
      menuPath: input.menuPath,
      formFields: input.formFields,
    },
  });
  if (action.dryRun === false) {
    const preflight = await input.executionPort.execute({
      schemaVersion: 'browser-execution-request.v1',
      requestId: nowId('browser-preflight'),
      sessionId: input.sessionId,
      origin: new URL(session.targetUrl).origin,
      operation: { kind: 'observe_console', includeSnapshot: false },
    });
    if (!isAuthoritativePass(preflight)) {
      throw new Error(preflight.error?.message ?? `Live execution preflight failed: ${preflight.status}`);
    }
    await consumeRealExecutionApprovalNonce(approvalAction, input.approval);
  }
  const result = await input.executionPort.execute(actionRequest);
  const passed = isAuthoritativePass(result);
  session.status = passed
    ? 'completed'
    : result.mutationAttempted && result.status === 'INDETERMINATE'
      ? 'verification_required'
      : 'failed';
  return {
    ok: passed,
    dryRun: action.dryRun !== false,
    approvalRequired: approval.required,
    message: result.error?.message ?? `JM browser execution: ${result.status}`,
    beforeScreenshotPath: result.evidence[0]?.artifactRef,
    afterScreenshotPath: result.evidence.at(-1)?.artifactRef,
  };
}
