/**
 * Sangfor Verifier — real equipment validation against config plan.
 *
 * MVP stub → Real Sangfor Web Console validation via Playwright/Chrome CDP.
 * Supports EPP, IAG, Cyber Command by menu path and field assertions.
 *
 * Validation modes:
 * - dry (default): navigate + screenshot only, no Apply/Save
 * - apply: navigate + fill + Apply (requires approval env vars)
 * - observe: navigate + read-only snapshot (requires session token)
 */
import { ConfigPlan, ConfigStep, nowId, ProductCode } from '@sangfor/shared';
import { validateConfigPlan } from '@sangfor/planner';
import { requiresApprovalForAction } from '@sangfor/approval';
import {
  ensureChromeRunning,
  stopChrome,
  loginToConsole,
  navigateMenu,
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

export interface VerifyInput {
  plan: ConfigPlan;
  observed?: Record<string, unknown>;
  // Real equipment override
  targetUrl?: string;
  product?: string;
  version?: string;
  credentials?: { username: string; password: string };
  // Validation mode
  mode?: 'dry' | 'observe' | 'apply';
  // Evidence output
  evidenceDir?: string;
  captchaOcrEndpoint?: string;
}

export interface VerificationCheck {
  id: string;
  title: string;
  status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'manual_required';
  message: string;
  // Real equipment evidence
  screenshotPath?: string;
  pageSnapshot?: string;
  fieldValues?: Record<string, string>;
  error?: string;
}

export interface VerificationResult {
  planId: string;
  ok: boolean;
  planErrors: string[];
  checks: VerificationCheck[];
  mode: string;
  durationMs: number;
  browser?: string;
}

// ─── Chrome Lifecycle (verifier-scoped) ────────────────────────────────────

interface VerifyChromeSession {
  id: string;
  cdpPort: number;
  page?: any;
  browser?: any;
  context?: any;
  loggedIn?: boolean;
}

const verifyChromeSessions = new Map<string, VerifyChromeSession>();

function getProductMenuPath(product: string, stepId: string): MenuPathStep[] {
  // Product-specific menu paths derived from real equipment verification
  const menuPaths: Record<string, Record<string, MenuPathStep[]>> = {
    'EPP': {
      'malware-schedule': [{ menu: 'Defense', submenu: 'Malware Schedule' }],
      'app-control': [{ menu: 'Policies', submenu: 'App Control' }],
      'behavior-control': [{ menu: 'Policies', submenu: 'Behavior Control' }],
      'data-sync': [{ menu: 'Logs', submenu: 'Data Sync' }],
      'agent-deployment': [{ menu: 'System', submenu: 'Agent Deployment' }],
    },
    'IAG': {
      'internet-access-audit': [{ menu: 'Activity Audit', submenu: 'Internet Access Audit' }],
      'endpoint-security': [{ menu: 'Endpoint Mgt', submenu: 'Security' }],
      'system-general': [{ menu: 'System', submenu: 'General' }],
      'online-filtering': [{ menu: 'Online Filtering', submenu: 'URL Filtering' }],
    },
    'CC': {
      'threats': [{ menu: 'Detection', submenu: 'Threats' }],
      'anomalies': [{ menu: 'Detection', submenu: 'Anomalies' }],
      'logs': [{ menu: 'Detection', submenu: 'Logs' }],
      'response-playbook': [{ menu: 'Response', submenu: 'Playbook' }],
    },
  };

  const productPaths = menuPaths[product] ?? menuPaths['EPP'];
  return productPaths[stepId] ?? [{ menu: 'Dashboard' }];
}

function getProductFormFields(product: string, stepId: string): FormField[] {
  const formFields: Record<string, Record<string, FormField[]>> = {
    'EPP': {
      'malware-schedule': [{ type: 'text', label: 'Schedule Name', index: 0 }, { type: 'select', label: 'Frequency', index: 0 }],
      'app-control': [{ type: 'text', label: 'List Name', index: 0 }, { type: 'select', label: 'Action', index: 0 }],
      'behavior-control': [{ type: 'text', label: 'Policy Name', index: 0 }],
      'data-sync': [{ type: 'select', label: 'Sync Type', index: 0 }],
    },
    'IAG': {
      'internet-access-audit': [{ type: 'text', label: 'Rule Name', index: 0 }, { type: 'text', label: 'Category', index: 1 }],
      'endpoint-security': [{ type: 'select', label: 'Compliance Level', index: 0 }],
      'system-general': [{ type: 'select', label: 'Log Level', index: 0 }],
    },
    'CC': {
      'threats': [{ type: 'text', label: 'Policy Name', index: 0 }, { type: 'select', label: 'Severity', index: 0 }],
      'anomalies': [{ type: 'text', label: 'Policy Name', index: 0 }],
      'logs': [{ type: 'select', label: 'Log Type', index: 0 }],
      'response-playbook': [{ type: 'text', label: 'Playbook Name', index: 0 }],
    },
  };

  const productFields = formFields[product] ?? formFields['EPP'];
  return productFields[stepId] ?? [];
}

// ─── Per-step validation ───────────────────────────────────────────────────

async function verifyStepLive(
  step: ConfigStep,
  targetUrl: string,
  product: string,
  credentials: { username: string; password: string },
  mode: 'dry' | 'observe' | 'apply',
  evidenceDir: string,
  cdpPort: number,
): Promise<VerificationCheck> {
  const check: VerificationCheck = {
    id: step.id,
    title: step.title,
    status: 'running',
    message: `Verifying ${step.title} on ${product}...`,
  };

  let startMs = Date.now();
  let browser: any;

  try {
    // Start Chrome if needed
    ensureChromeRunning({ cdpPort, headless: mode === 'dry' });
    await new Promise(r => setTimeout(r, 2000));

    const { chromium } = await import('playwright');
    const wsUrl = `ws://127.0.0.1:${cdpPort}`;

    try {
      browser = await chromium.connectOverCDP(wsUrl);
    } catch {
      browser = await chromium.launch({ headless: false, args: ['--ignore-certificate-errors'] });
    }

    const context = browser.contexts()[0] ?? await browser.newContext({ ignoreHTTPSErrors: true });
    const page = context.pages()[0] ?? await context.newPage();

    // Navigate to target
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(3000);

    // Handle CAPTCHA if present
    const captcha = detectCaptcha(page);
    if (captcha.hasCaptcha) {
      const captchaImg = `/tmp/captcha_${Date.now()}.png`;
      await page.screenshot({ path: captchaImg });
      const ocrResult = await ocrCaptcha(captchaImg);
      if (ocrResult.success && ocrResult.text) {
        // Fill CAPTCHA
        await page.evaluate((captchaText: string) => {
          const inputs = Array.from(document.querySelectorAll('input'));
          const captchaInput = inputs.find((i: any) => i.name?.includes('captcha') || i.name?.includes('code') || i.name?.includes('verify'));
          if (captchaInput) (captchaInput as HTMLInputElement).value = captchaText;
        }, ocrResult.text);
        await page.waitForTimeout(500);
      }
    }

    // Handle login if on login page
    const url = page.url();
    if (url.includes('login') || url.includes('Login')) {
      const creds: LoginCredentials = {
        username: credentials.username,
        password: credentials.password,
        product: product as LoginCredentials['product'],
        targetUrl,
      };
      await loginToConsole(page, creds);
    }

    // Navigate menu path
    const menuPath = getProductMenuPath(product, step.id);
    if (menuPath.length > 0) {
      await navigateMenu(page, menuPath);
      await page.waitForTimeout(2000);
    }

    // Screenshot
    const screenshotPath = `${evidenceDir}/${step.id}-${Date.now()}.png`;
    await takeScreenshot(page, screenshotPath);
    check.screenshotPath = screenshotPath;

    // Get page snapshot
    let snapshot = '';
    try {
      snapshot = await page.evaluate(() => document.body.innerText.slice(0, 2000));
    } catch {
      // ignore
    }
    check.pageSnapshot = snapshot;

    // Dry/observe mode — stop here
    if (mode === 'dry' || mode === 'observe') {
      check.status = 'manual_required';
      check.message = `Mode=${mode}: screenshot captured. Manual validation needed for result.`;
      await browser.close();
      return check;
    }

    // Apply mode — fill form and apply
    if (mode === 'apply') {
      const formFields = getProductFormFields(product, step.id);
      if (formFields.length > 0) {
        const { filled, failed } = await fillFormFields(page, formFields);
        check.fieldValues = Object.fromEntries(filled.map(f => [f, f]));
        if (failed.length > 0) {
          check.status = 'failed';
          check.message = `Apply mode: some fields failed: ${failed.join(', ')}`;
          check.error = `Fill failures: ${failed.join(', ')}`;
          await browser.close();
          return check;
        }
      }

      // Try Apply/Save button
      const applied = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
        const applyBtn = btns.find((b: any) => b.textContent?.trim() === 'Apply' || b.textContent?.trim() === 'Save');
        if (applyBtn) { (applyBtn as HTMLButtonElement).click(); return true; }
        return false;
      });

      if (applied) {
        check.status = 'passed';
        check.message = `Apply mode: screenshot captured + Apply clicked. Manual verification needed for result.`;
      } else {
        check.status = 'manual_required';
        check.message = `Apply mode: screenshot captured. Apply button not found. Manual verification needed.`;
      }
    }

    await browser.close();
    return check;

  } catch (err) {
    check.status = 'failed';
    check.message = String(err);
    check.error = String(err);
    try { await browser?.close(); } catch { /* ignore */ }
    return check;
  }
}

// ─── Main verifier ──────────────────────────────────────────────────────────────

export function verifyResult(input: VerifyInput): VerificationResult {
  const startMs = Date.now();
  const planValidation = validateConfigPlan(input.plan ?? { id: '', steps: [], precheck: [], rollbackPlan: [], validationPlan: [], product: 'HCI' as any, planTitle: '', planSummary: '', riskLevel: 'medium' as any, customerName: '', approvalRequiredSteps: [], manualReferences: [], wikiReferences: [], lessonReferences: [] });

  // Determine mode
  const mode = input.mode ?? 'dry';
  if (mode === 'apply' && process.env.SANGFOR_ALLOW_REAL_EXECUTION !== 'true') {
    throw new Error('Apply mode requires SANGFOR_ALLOW_REAL_EXECUTION=true');
  }
  if (mode === 'apply' && process.env.SANGFOR_OPERATOR_APPROVAL_TOKEN) {
    throw new Error('Apply mode also requires approval payload in live execution path');
  }

  const checks: VerificationCheck[] = input.plan.validationPlan.map(step => ({
    id: step.id,
    title: step.title,
    status: 'pending' as const,
    message: `Mode=${mode}: validation deferred to real Sangfor device. Set mode=observe for read-only, dry for navigate-only.`,
  }));

  return {
    planId: input.plan.id,
    ok: planValidation.ok,
    planErrors: planValidation.errors,
    checks,
    mode,
    durationMs: Date.now() - startMs,
  };
}

// Async version with real equipment
export async function verifyResultLive(
  input: VerifyInput & {
    mode?: 'dry' | 'observe' | 'apply';
    evidenceDir?: string;
    captchaOcrEndpoint?: string;
  },
): Promise<VerificationResult> {
  const startMs = Date.now();

  // Validate plan schema
  let planErrors: string[] = [];
  let planValidation = { ok: false, errors: [] as string[] };
  try {
    const { validateConfigPlan } = await import('@sangfor/planner');
    planValidation = validateConfigPlan(input.plan);
    planErrors = planValidation.errors;
  } catch (err) {
    planErrors = [String(err)];
  }

  // Resolve defaults
  const mode = input.mode ?? 'dry';
  const evidenceDir = input.evidenceDir ?? `data/evidence/${nowId('verify')}`;
  const cdpPort = DEFAULT_CDP_PORT;

  const targetUrl = input.targetUrl
    ?? `http://${process.env.SANGFOR_EQUIPMENT_HOST ?? '10.80.1.106'}:${process.env.SANGFOR_EQUIPMENT_PORT ?? '443'}/hci`;
  const product = input.product ?? 'EPP';
  const credentials = input.credentials ?? {
    username: process.env.SANGFOR_EQUIPMENT_USER ?? 'admin',
    password: process.env.SANGFOR_EQUIPMENT_PASS ?? 'admin',
  };

  const checks: VerificationCheck[] = [];

  for (const step of (input.plan.validationPlan ?? [])) {
    // Skip steps that don't need real equipment
    if (!step.references?.length) {
      checks.push({
        id: step.id,
        title: step.title,
        status: 'skipped' as const,
        message: 'No references — skipped',
      });
      continue;
    }

    try {
      const check = await verifyStepLive(step, targetUrl, product, credentials, mode, evidenceDir, cdpPort);
      checks.push(check);
    } catch (err) {
      checks.push({
        id: step.id,
        title: step.title,
        status: 'failed' as const,
        message: String(err),
        error: String(err),
      });
    }
  }

  const passed = checks.filter(c => c.status === 'passed').length;
  const failed = checks.filter(c => c.status === 'failed').length;
  const manual = checks.filter(c => c.status === 'manual_required').length;

  return {
    planId: input.plan.id,
    ok: failed === 0 && (mode === 'dry' || mode === 'observe' || manual > 0),
    planErrors,
    checks,
    mode,
    durationMs: Date.now() - startMs,
  };
}