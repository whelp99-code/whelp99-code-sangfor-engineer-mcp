import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { requiresApprovalForAction } from '@sangfor/approval';
import { ConsoleAction, ConsoleActionResult, nowId, ProductCode } from '@sangfor/shared';
import { verifyExecutionApproval } from './approval.js';
import {
  ensureChromeRunning,
  stopChrome,
  loginToConsole,
  navigateMenu,
  openFormDialog,
  fillFormFields,
  takeScreenshot,
  getPageSnapshot,
  detectCaptcha,
  ocrCaptcha,
  type ChromeSession,
  type LoginCredentials,
  type MenuPathStep,
  type FormField,
  DEFAULT_CDP_PORT,
} from '@sangfor/chrome';

export type OperatorMode = 'mock' | 'lab' | 'poc' | 'customer_readonly' | 'customer_write' | 'production';

export interface OperatorSession {
  id: string;
  product: string;
  mode: OperatorMode;
  targetUrl?: string;
  browser?: OperatorBrowserOptions;
  status: 'pending' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled';
  approvedChangeTicketId?: string;
  rollbackPlanId?: string;
  cdpPort?: number;
  chromeSession?: ChromeSession;
  credentials?: { username: string; password: string };
  loggedIn?: boolean;
}

export interface OperatorBrowserOptions {
  cdpEndpoint?: string;
  useLocalBrowser?: boolean;
  cdpPort?: number;
  startIfMissing?: boolean;
}

export interface LiveExecutionApproval {
  approvedBy: string;
  approvalToken: string; // hex HMAC-SHA256 signature, action-bound (see ./approval)
  changeTicketId: string;
  rollbackPlanId: string;
  nonce: string;
  expiresAt: string; // ISO 8601 — approval is rejected past this instant
  maintenanceWindow?: string;
}

export interface LiveConsoleActionInput {
  sessionId: string;
  action: ConsoleAction;
  approval?: LiveExecutionApproval;
  menuPath?: MenuPathStep[];
  formFields?: FormField[];
}

const sessions = new Map<string, OperatorSession>();
const liveConnections = new Map<string, { browser: any; page: any; context: any; connectedOverCdp: boolean }>();
const CLICK_TARGET_SELECTOR = [
  'button',
  'a',
  '[role="button"]',
  'input[type="button"]',
  'input[type="submit"]',
  '[data-action]',
  '[onclick]',
  '[class*="x-btn"]',
  '[class*="x-menu-item"]',
  '[class*="x-boundlist-item"]',
].join(', ');
const INPUT_TARGET_SELECTOR = 'input:not([type="hidden"]):not([disabled]), textarea:not([disabled])';

// ─── Session Management ────────────────────────────────────────────────────────

export function startOperatorSession(
  input: {
    product: string;
    mode?: OperatorMode;
    targetUrl?: string;
    approvedChangeTicketId?: string;
    rollbackPlanId?: string;
    browser?: OperatorBrowserOptions;
    credentials?: { username: string; password: string };
  }
): OperatorSession {
  const session: OperatorSession = {
    id: nowId('session'),
    product: input.product,
    mode: input.mode ?? 'mock',
    targetUrl: input.targetUrl ?? 'http://localhost:3400/hci',
    browser: input.browser,
    status: 'running',
    approvedChangeTicketId: input.approvedChangeTicketId,
    rollbackPlanId: input.rollbackPlanId,
    cdpPort: input.browser?.cdpPort ?? DEFAULT_CDP_PORT,
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
      message: `Blocked: approval required. Reason: ${approval.reason}`,
    };
  }

  // The mock console must never fabricate a real "Executed" result. Any non-dry-run
  // request has to go through the live signed-approval path (executeLiveConsoleAction),
  // so it fails closed here rather than claiming a write it did not perform.
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

// ─── Real Execution Guards ────────────────────────────────────────────────────

export function assertRealExecutionAllowed(session: OperatorSession, action: ConsoleAction, approval?: LiveExecutionApproval): void {
  if (action.dryRun !== false) return;
  if (process.env.SANGFOR_ALLOW_REAL_EXECUTION !== 'true') {
    throw new Error('Live execution blocked. Set SANGFOR_ALLOW_REAL_EXECUTION=true only in an authorized lab/customer session.');
  }
  if (session.mode === 'production' && process.env.SANGFOR_ALLOW_PRODUCTION_EXECUTION !== 'true') {
    throw new Error('Production execution blocked. Set SANGFOR_ALLOW_PRODUCTION_EXECUTION=true only after formal change approval.');
  }
  // Approval must be a signature bound to THIS exact action (type+target), keyed
  // by a server-side secret, and unexpired. A static shared token is no longer
  // accepted: it was replayable across actions and time (redteam H1).
  const verdict = verifyExecutionApproval({
    action: { type: action.type, target: action.target },
    approval,
    secret: process.env.SANGFOR_OPERATOR_APPROVAL_SECRET,
  });
  if (!verdict.ok) {
    throw new Error(`Live execution approval rejected: ${verdict.reason}.`);
  }
}

// ─── Chrome Lifecycle ─────────────────────────────────────────────────────────

async function ensureLivePage(session: OperatorSession): Promise<{ browser: any; page: any; context: any; connectedOverCdp: boolean }> {
  const cached = liveConnections.get(session.id);
  if (cached?.browser?.isConnected?.()) return cached;

  const cdpPort = session.cdpPort ?? DEFAULT_CDP_PORT;

  // Auto-start Chrome if requested and not running
  if (session.browser?.startIfMissing !== false && !session.browser?.useLocalBrowser) {
    ensureChromeRunning({ cdpPort, headless: false });
    // Give Chrome time to start
    await new Promise(resolve => setTimeout(resolve, 3000));
  }

  const { chromium } = await import('playwright');
  const cdpEndpoint = session.browser?.cdpEndpoint ?? process.env.SANGFOR_OPERATOR_CDP_ENDPOINT ?? `http://127.0.0.1:${cdpPort}`;

  let browser: any;
  let context: any;
  let page: any;
  let connectedOverCdp = false;

  if (session.browser?.useLocalBrowser || cdpEndpoint) {
    // Connect to existing Chrome via CDP
    try {
      const wsUrl = `ws://127.0.0.1:${cdpPort}`;
      browser = await chromium.connectOverCDP(wsUrl);
      context = browser.contexts()[0] ?? await browser.newContext({ ignoreHTTPSErrors: true });
      const existingPage = context.pages().find((p: any) => session.targetUrl && p.url().includes(session.targetUrl!.split('://')[1]?.split('/')[0]));
      page = existingPage ?? context.pages()[0] ?? await context.newPage();
      connectedOverCdp = true;
    } catch {
      // Fallback: launch fresh browser
      browser = await chromium.launch({ headless: false, args: ['--ignore-certificate-errors'] });
      context = await browser.newContext({ ignoreHTTPSErrors: true });
      page = await context.newPage();
      connectedOverCdp = false;
    }
  } else {
    browser = await chromium.launch({ headless: false, args: ['--ignore-certificate-errors'] });
    context = await browser.newContext({ ignoreHTTPSErrors: true });
    page = await context.newPage();
  }

  const connection = { browser, page, context, connectedOverCdp };
  liveConnections.set(session.id, connection);
  return connection;
}

async function releaseLivePage(sessionId: string): Promise<void> {
  const conn = liveConnections.get(sessionId);
  if (!conn) return;
  if (conn.connectedOverCdp) {
    // Keep CDP connection alive for session reuse
    return;
  }
  liveConnections.delete(sessionId);
  try { await conn.browser.close(); } catch { /* ignore */ }
}

// ─── Fail-Closed Live Action Locators ────────────────────────────────────────

function strictTargetError(action: string, target: string, count: number): Error {
  if (count === 0) return new Error(`Could not ${action}: no unique target matched "${target}"`);
  return new Error(`Could not ${action}: ambiguous target "${target}" matched ${count} elements`);
}

export async function clickUniqueTextTarget(page: any, target: string): Promise<void> {
  const locator = page.locator(CLICK_TARGET_SELECTOR);
  const matches = await locator.evaluateAll((elements: Element[], wanted: string) => {
    const isVisible = (el: Element) => {
      const style = window.getComputedStyle(el);
      const rect = (el as HTMLElement).getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const textOf = (el: Element) => {
      if (el instanceof HTMLInputElement) return el.value || el.getAttribute('aria-label') || el.title || '';
      return el.textContent?.trim() || el.getAttribute('aria-label') || el.getAttribute('title') || '';
    };
    return elements
      .map((el, index) => ({ index, text: textOf(el).trim(), visible: isVisible(el) }))
      .filter((item) => item.visible && item.text === wanted)
      .map((item) => item.index);
  }, target);
  if (matches.length !== 1) throw strictTargetError('click', target, matches.length);
  await locator.nth(matches[0]).click();
}

export async function typeUniqueInputTarget(page: any, target: string, value: string): Promise<void> {
  const locator = page.locator(INPUT_TARGET_SELECTOR);
  const matches = await locator.evaluateAll((elements: Element[], wanted: string) => {
    const isVisible = (el: Element) => {
      const style = window.getComputedStyle(el);
      const rect = (el as HTMLElement).getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const keyOf = (el: Element) => [
      el.getAttribute('name'),
      el.getAttribute('id'),
      el.getAttribute('aria-label'),
      el.getAttribute('placeholder'),
    ].filter(Boolean);
    return elements
      .map((el, index) => ({ index, keys: keyOf(el), visible: isVisible(el) }))
      .filter((item) => item.visible && item.keys.includes(wanted))
      .map((item) => item.index);
  }, target);
  if (matches.length !== 1) throw strictTargetError('type into', target, matches.length);
  const input = locator.nth(matches[0]);
  await input.fill(value);
  await input.dispatchEvent('change');
}

export async function selectUniqueTarget(page: any, target: string, value: string): Promise<void> {
  let locator = page.locator(target);
  let count = await locator.count().catch(() => 0);

  if (count === 0) {
    locator = page.locator('select').filter({ has: page.locator(`option`) });
    const matches = await locator.evaluateAll((elements: HTMLSelectElement[], wanted: string) => {
      const isVisible = (el: Element) => {
        const style = window.getComputedStyle(el);
        const rect = (el as HTMLElement).getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };
      return elements
        .map((el, index) => ({
          index,
          keys: [el.getAttribute('name'), el.getAttribute('id'), el.getAttribute('aria-label')].filter(Boolean),
          visible: isVisible(el),
        }))
        .filter((item) => item.visible && item.keys.includes(wanted))
        .map((item) => item.index);
    }, target);
    count = matches.length;
    if (count !== 1) throw strictTargetError('select', target, count);
    await locator.nth(matches[0]).selectOption(value);
    return;
  }

  if (count !== 1) throw strictTargetError('select', target, count);
  await locator.selectOption(value);
}

// ─── Live Read ───────────────────────────────────────────────────────────────

export async function readLiveConsoleState(input: { sessionId: string }): Promise<Record<string, unknown>> {
  const session = getOperatorSession(input.sessionId);
  if (session.mode === 'mock') return readConsoleState(input.sessionId);
  if (!session.targetUrl) throw new Error('Live console state requires targetUrl.');

  const { page, browser, connectedOverCdp } = await ensureLivePage(session);

  try {
    // Navigate to target
    await page.goto(session.targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(3000);

    // Handle CAPTCHA if present
    let captchaHandled = false;
    const captcha = detectCaptcha(page);
    if (captcha.hasCaptcha && session.credentials) {
      const creds: LoginCredentials = {
        username: session.credentials.username,
        password: session.credentials.password,
        product: session.product as LoginCredentials['product'],
        targetUrl: session.targetUrl,
      };
      await loginToConsole(page, creds);
      captchaHandled = true;
    }

    // Snapshot
    const title = await page.title();
    const url = page.url();
    let snapshot: string;
    try {
      snapshot = await page.locator('body').ariaSnapshot({ timeout: 5000 });
    } catch {
      snapshot = await page.evaluate(() => document.body.innerText);
    }

    const screenshotPath = `data/evidence/${input.sessionId}/live-state-${Date.now()}.png`;
    await takeScreenshot(page, screenshotPath);

    return {
      sessionId: input.sessionId,
      mode: session.mode,
      title,
      url,
      snapshot,
      screenshotPath,
      captchaHandled,
      browser: connectedOverCdp ? 'local-cdp' : 'launched-chromium',
      product: session.product,
    };
  } finally {
    await releaseLivePage(input.sessionId);
  }
}

// ─── Live Execute ─────────────────────────────────────────────────────────────

export async function executeLiveConsoleAction(input: LiveConsoleActionInput): Promise<ConsoleActionResult> {
  const session = getOperatorSession(input.sessionId);
  const action = { ...input.action, dryRun: input.action.dryRun !== false ? true : false };
  const approval = requiresApprovalForAction(action);

  assertRealExecutionAllowed(session, action, input.approval);

  if (approval.required && action.dryRun === false && !input.approval) {
    session.status = 'waiting_approval';
    return { ok: false, dryRun: false, approvalRequired: true, message: `Blocked: ${approval.reason}` };
  }

  if (!session.targetUrl) throw new Error('Live execution requires targetUrl.');

  const { page, connectedOverCdp } = await ensureLivePage(session);

  const evidenceDir = `data/evidence/${input.sessionId}`;
  mkdirSync(evidenceDir, { recursive: true });
  const beforeScreenshotPath = `${evidenceDir}/before-live-${Date.now()}.png`;
  const afterScreenshotPath = `${evidenceDir}/after-live-${Date.now()}.png`;

  try {
    // Navigate
    await page.goto(session.targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(3000);

    // Handle login if needed
    if (!session.loggedIn && session.credentials) {
      const captcha = detectCaptcha(page);
      if (captcha.hasCaptcha) {
        const creds: LoginCredentials = {
          username: session.credentials.username,
          password: session.credentials.password,
          product: session.product as LoginCredentials['product'],
          targetUrl: session.targetUrl,
        };
        await loginToConsole(page, creds);
        session.loggedIn = true;
      }
    }

    await takeScreenshot(page, beforeScreenshotPath);

    // ─── Navigate menu path if provided ──────────────────────────────
    if (input.menuPath?.length) {
      await navigateMenu(page, input.menuPath);
    }

    // ─── Dry-run guard ─────────────────────────────────────────────
    if (action.dryRun !== false && ['click', 'type', 'select'].includes(action.type)) {
      await takeScreenshot(page, afterScreenshotPath);
      return {
        ok: true,
        dryRun: true,
        approvalRequired: approval.required,
        message: `Live dry-run stopped before ${action.type} on ${action.target ?? '<no target>'}. Browser=${connectedOverCdp ? 'local-cdp' : 'launched-chromium'}.`,
        beforeScreenshotPath,
        afterScreenshotPath,
      };
    }

    // ─── Execute action ──────────────────────────────────────────────
    if (action.type === 'navigate') {
      if (!action.value && !action.target) throw new Error('navigate action requires value or target URL');
      await page.goto(action.value ?? action.target!, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(2000);
    } else if (action.type === 'click') {
      if (!action.target) throw new Error('click action requires target');
      await clickUniqueTextTarget(page, action.target);
      await page.waitForTimeout(1000);
    } else if (action.type === 'type') {
      if (!action.target) throw new Error('type action requires target');
      await typeUniqueInputTarget(page, action.target, action.value ?? '');
    } else if (action.type === 'select') {
      if (!action.target) throw new Error('select action requires target');
      await selectUniqueTarget(page, action.target, action.value ?? '');
    } else if (action.type === 'scroll') {
      await page.mouse.wheel(0, Number(action.value ?? 500));
    } else if (action.type === 'wait') {
      await page.waitForTimeout(Number(action.value ?? 1000));
    }

    // ─── Fill form fields if provided ───────────────────────────────
    if (input.formFields?.length) {
      const { filled, failed } = await fillFormFields(page, input.formFields);
      if (failed.length > 0) {
        console.warn(`[Operator] Some form fields failed: ${failed.join(', ')}`);
      }
    }

    await takeScreenshot(page, afterScreenshotPath);

    return {
      ok: true,
      dryRun: action.dryRun !== false,
      approvalRequired: approval.required,
      message: action.dryRun !== false
        ? `Live dry-run executed in ${session.mode} mode. Browser=${connectedOverCdp ? 'local-cdp' : 'launched-chromium'}.`
        : `Live action executed in ${session.mode} mode by ${input.approval?.approvedBy ?? 'unknown'} under change ticket ${input.approval?.changeTicketId ?? 'n/a'}. Browser=${connectedOverCdp ? 'local-cdp' : 'launched-chromium'}.`,
      beforeScreenshotPath,
      afterScreenshotPath,
    };
  } catch (error) {
    session.status = 'failed';
    try { await takeScreenshot(page, afterScreenshotPath); } catch { /* ignore */ }
    return {
      ok: false,
      dryRun: false,
      approvalRequired: approval.required,
      message: error instanceof Error ? error.message : String(error),
      beforeScreenshotPath,
      afterScreenshotPath,
    };
  } finally {
    await releaseLivePage(input.sessionId);
  }
}

export function killSession(sessionId: string): OperatorSession {
  const session = getOperatorSession(sessionId);
  session.status = 'cancelled';
  const conn = liveConnections.get(sessionId);
  if (conn) {
    liveConnections.delete(sessionId);
    try { conn.browser.close(); } catch { /* ignore */ }
  }
  // Optionally stop Chrome
  if (session.cdpPort) {
    stopChrome(session.cdpPort);
  }
  return session;
}
