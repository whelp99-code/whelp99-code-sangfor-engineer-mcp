import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { requiresApprovalForAction } from '@sangfor/approval';
import { ConsoleAction, ConsoleActionResult, nowId } from '@sangfor/shared';

export type OperatorMode = 'mock' | 'lab' | 'poc' | 'customer_readonly' | 'customer_write' | 'production';

export interface OperatorSession {
  id: string;
  product: string;
  mode: OperatorMode;
  targetUrl?: string;
  status: 'pending' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled';
  approvedChangeTicketId?: string;
  rollbackPlanId?: string;
}

export interface LiveExecutionApproval {
  approvedBy: string;
  approvalToken: string;
  changeTicketId: string;
  rollbackPlanId: string;
  maintenanceWindow?: string;
}

export interface LiveConsoleActionInput {
  sessionId: string;
  action: ConsoleAction;
  approval?: LiveExecutionApproval;
}

const sessions = new Map<string, OperatorSession>();

export function startOperatorSession(input: { product: string; mode?: OperatorMode; targetUrl?: string; approvedChangeTicketId?: string; rollbackPlanId?: string }): OperatorSession {
  const session: OperatorSession = {
    id: nowId('session'),
    product: input.product,
    mode: input.mode ?? 'mock',
    targetUrl: input.targetUrl ?? 'http://localhost:3400/hci',
    status: 'running',
    approvedChangeTicketId: input.approvedChangeTicketId,
    rollbackPlanId: input.rollbackPlanId
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
      { role: 'button', name: 'Export' }
    ],
    warning: session.mode === 'mock'
      ? 'Mock state. Use live read with Playwright only after lab validation.'
      : 'Live mode requires explicit approval and environment flags before write actions.'
  };
}

export function executeConsoleAction(sessionId: string, action: ConsoleAction): ConsoleActionResult {
  const session = getOperatorSession(sessionId);
  const dryRun = action.dryRun !== false;
  const approval = requiresApprovalForAction(action);

  if (approval.required && !dryRun) {
    session.status = 'waiting_approval';
    return {
      ok: false,
      dryRun,
      approvalRequired: true,
      message: `Blocked: approval required. Reason: ${approval.reason}`
    };
  }

  return {
    ok: true,
    dryRun,
    approvalRequired: approval.required,
    message: dryRun
      ? `Dry-run only: would execute ${action.type} on ${action.target ?? '<no target>'}.`
      : `Executed ${action.type} on ${action.target ?? '<no target>'}.`,
    beforeScreenshotPath: `.evidence/${sessionId}/before-${Date.now()}.png`,
    afterScreenshotPath: `.evidence/${sessionId}/after-${Date.now()}.png`
  };
}

function assertRealExecutionAllowed(session: OperatorSession, action: ConsoleAction, approval?: LiveExecutionApproval): void {
  if (action.dryRun !== false) return;
  if (process.env.SANGFOR_ALLOW_REAL_EXECUTION !== 'true') {
    throw new Error('Live execution blocked. Set SANGFOR_ALLOW_REAL_EXECUTION=true only in an authorized lab/customer session.');
  }
  if (session.mode === 'production' && process.env.SANGFOR_ALLOW_PRODUCTION_EXECUTION !== 'true') {
    throw new Error('Production execution blocked. Set SANGFOR_ALLOW_PRODUCTION_EXECUTION=true only after formal change approval.');
  }
  if (!approval?.approvedBy || !approval.approvalToken || !approval.changeTicketId || !approval.rollbackPlanId) {
    throw new Error('Live execution requires approvedBy, approvalToken, changeTicketId, and rollbackPlanId.');
  }
  if (approval.approvalToken !== process.env.SANGFOR_OPERATOR_APPROVAL_TOKEN) {
    throw new Error('Live execution approval token mismatch.');
  }
}

async function captureScreenshot(page: any, path: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  await page.screenshot({ path, fullPage: true });
}

export async function readLiveConsoleState(input: { sessionId: string }): Promise<Record<string, unknown>> {
  const session = getOperatorSession(input.sessionId);
  if (session.mode === 'mock') return readConsoleState(input.sessionId);
  if (!session.targetUrl) throw new Error('Live console state requires targetUrl.');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: process.env.SANGFOR_OPERATOR_HEADLESS !== 'false' });
  const page = await browser.newPage({ ignoreHTTPSErrors: true });
  try {
    await page.goto(session.targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const title = await page.title();
    const url = page.url();
    const snapshot = await page.locator('body').ariaSnapshot().catch(async () => page.locator('body').innerText({ timeout: 5_000 }));
    const screenshotPath = `data/evidence/${input.sessionId}/live-state-${Date.now()}.png`;
    await captureScreenshot(page, screenshotPath);
    return { sessionId: input.sessionId, mode: session.mode, title, url, snapshot, screenshotPath };
  } finally {
    await browser.close();
  }
}

export async function executeLiveConsoleAction(input: LiveConsoleActionInput): Promise<ConsoleActionResult> {
  const session = getOperatorSession(input.sessionId);
  const action = { ...input.action, dryRun: input.action.dryRun !== false ? true : false };
  const approval = requiresApprovalForAction(action);

  assertRealExecutionAllowed(session, action, input.approval);

  if (approval.required && action.dryRun === false && !input.approval) {
    session.status = 'waiting_approval';
    return { ok: false, dryRun: false, approvalRequired: true, message: `Blocked: ${approval.reason}` };
  }

  if (action.dryRun !== false) {
    return executeConsoleAction(input.sessionId, action);
  }

  if (!session.targetUrl) throw new Error('Live execution requires targetUrl.');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: process.env.SANGFOR_OPERATOR_HEADLESS !== 'false' });
  const page = await browser.newPage({ ignoreHTTPSErrors: true });
  const beforeScreenshotPath = `data/evidence/${input.sessionId}/before-live-${Date.now()}.png`;
  const afterScreenshotPath = `data/evidence/${input.sessionId}/after-live-${Date.now()}.png`;
  try {
    await page.goto(session.targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await captureScreenshot(page, beforeScreenshotPath);
    if (action.type === 'navigate') {
      if (!action.value && !action.target) throw new Error('navigate action requires value or target URL');
      await page.goto(action.value ?? action.target!, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } else if (action.type === 'click') {
      if (!action.target) throw new Error('click action requires target');
      await page.getByRole('button', { name: action.target }).click().catch(async () => page.getByText(action.target!, { exact: false }).click());
    } else if (action.type === 'type') {
      if (!action.target) throw new Error('type action requires target');
      await page.getByLabel(action.target).fill(action.value ?? '').catch(async () => page.locator(action.target!).fill(action.value ?? ''));
    } else if (action.type === 'select') {
      if (!action.target) throw new Error('select action requires target');
      await page.locator(action.target).selectOption(action.value ?? '');
    } else if (action.type === 'scroll') {
      await page.mouse.wheel(0, Number(action.value ?? 500));
    } else if (action.type === 'wait') {
      await page.waitForTimeout(Number(action.value ?? 1000));
    } else if (action.type === 'screenshot') {
      // screenshots are already captured before/after
    }
    await captureScreenshot(page, afterScreenshotPath);
    return {
      ok: true,
      dryRun: false,
      approvalRequired: approval.required,
      message: `Live action executed in ${session.mode} mode by ${input.approval?.approvedBy ?? 'unknown'} under change ticket ${input.approval?.changeTicketId ?? 'n/a'}.`,
      beforeScreenshotPath,
      afterScreenshotPath
    };
  } catch (error) {
    session.status = 'failed';
    return {
      ok: false,
      dryRun: false,
      approvalRequired: approval.required,
      message: error instanceof Error ? error.message : String(error),
      beforeScreenshotPath,
      afterScreenshotPath
    };
  } finally {
    await browser.close();
  }
}

export function killSession(sessionId: string): OperatorSession {
  const session = getOperatorSession(sessionId);
  session.status = 'cancelled';
  return session;
}
