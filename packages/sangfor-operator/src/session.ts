import { requiresApprovalForAction } from '@sangfor/approval';
import {
  type ConsoleAction,
  type ConsoleActionResult,
  nowId,
} from '../../shared/src/index.js';
import type {
  BrowserExecutionPort,
} from '../../sangfor-browser-contracts/src/index.js';
import type {
  OperatorBrowserOptions,
  OperatorMode,
  OperatorSession,
} from './types.js';

const DEFAULT_CDP_PORT = 9333;
const sessions = new Map<string, OperatorSession>();

function safeCdpPort(value: unknown): number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 1
    || value > 65_535
  ) {
    throw new Error('CDP_PORT_INVALID: expected an integer from 1 through 65535.');
  }
  return value;
}

export function startOperatorSession(input: {
  product: string;
  mode?: OperatorMode;
  targetUrl?: string;
  approvedChangeTicketId?: string;
  rollbackPlanId?: string;
  browser?: OperatorBrowserOptions;
  credentials?: { username: string; password: string };
}): OperatorSession {
  const session: OperatorSession = {
    id: nowId('session'),
    product: input.product,
    mode: input.mode ?? 'mock',
    targetUrl: input.targetUrl ?? 'http://localhost:3400/hci',
    browser: input.browser,
    status: 'running',
    approvedChangeTicketId: input.approvedChangeTicketId,
    rollbackPlanId: input.rollbackPlanId,
    cdpPort: safeCdpPort(input.browser?.cdpPort ?? DEFAULT_CDP_PORT),
    credentials: input.credentials,
  };
  sessions.set(session.id, session);
  return session;
}

export function getOperatorSession(sessionId: string): OperatorSession {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Unknown session: ${sessionId}`);
  return session;
}

export function readConsoleState(sessionId: string): Record<string, unknown> {
  const session = getOperatorSession(sessionId);
  return {
    sessionId,
    product: session.product,
    mode: session.mode,
    targetUrl: session.targetUrl,
    screen: session.mode === 'mock' ? 'mock-console-state' : 'live-console-state-pending-snapshot',
    availableElements: [
      { role: 'navigation', name: 'Dashboard' },
      { role: 'navigation', name: 'Network' },
      { role: 'navigation', name: 'Policy' },
      { role: 'button', name: 'Save' },
      { role: 'button', name: 'Apply' },
      { role: 'button', name: 'Export' },
    ],
    warning: session.mode === 'mock'
      ? 'Mock state. Use live read with Playwright only after lab validation.'
      : 'Live mode requires explicit approval and environment flags before write actions.',
  };
}

export function executeConsoleAction(
  sessionId: string,
  action: ConsoleAction,
): ConsoleActionResult {
  const session = getOperatorSession(sessionId);
  const dryRun = action.dryRun !== false;
  const approval = requiresApprovalForAction(action);
  if (approval.required && !dryRun) {
    session.status = 'waiting_approval';
    return {
      ok: false,
      dryRun,
      approvalRequired: true,
      message: `Blocked: approval required. Reason: ${approval.reason}`,
    };
  }
  if (!dryRun) {
    return {
      ok: false,
      dryRun,
      approvalRequired: approval.required,
      message: 'Blocked: the mock console cannot perform live execution. Use the live signed-approval path (executeLiveConsoleAction).',
    };
  }
  return {
    ok: true,
    dryRun,
    approvalRequired: approval.required,
    message: `Dry-run only: would execute ${action.type} on ${action.target ?? '<no target>'}.`,
    beforeScreenshotPath: `.evidence/${sessionId}/before-${Date.now()}.png`,
    afterScreenshotPath: `.evidence/${sessionId}/after-${Date.now()}.png`,
  };
}

export function killSession(sessionId: string): OperatorSession {
  const session = getOperatorSession(sessionId);
  session.status = 'cancelled';
  delete session.credentials;
  sessions.delete(sessionId);
  return session;
}

export async function closeOperatorSession(
  sessionId: string,
  executionPort: BrowserExecutionPort,
): Promise<OperatorSession> {
  const session = getOperatorSession(sessionId);
  let killed: OperatorSession | undefined;
  try {
    const closed = await executionPort.execute({
      schemaVersion: 'browser-execution-request.v1',
      requestId: `close-${session.id}`,
      sessionId: session.id,
      origin: new URL(session.targetUrl ?? 'http://localhost:3400/hci').origin,
      operation: { kind: 'close_session' },
    });
    if (closed.status !== 'PASS') {
      throw new Error(
        closed.error?.message ?? `Browser close result: ${closed.status}`,
      );
    }
  } finally {
    killed = killSession(sessionId);
  }
  return killed;
}
