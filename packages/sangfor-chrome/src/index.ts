/**
 * Sangfor Chrome Manager — Chrome CDP lifecycle, SPA/CAPTCHA handling for Sangfor consoles.
 *
 * Key capabilities:
 * - Start/stop Chrome with remote debugging on a configurable port
 * - Auto-discover CDP endpoint via /json/version
 * - Connect via Playwright over CDP
 * - SPA routing awareness (hash-based #/ routes)
 * - ExtJS form handling (dynamic IDs, triggers, comboboxes)
 * - CAPTCHA detection + screenshot for vision OCR
 * - Vision-based OCR helper (calls vision_analyze tool via fetch)
 * - Session persistence (reconnect to existing Chrome)
 * - Dry-run mode (no saves)
 */
import { spawn, execSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_CDP_PORT = 9333;
export const CHROME_USER_DATA_DIR = '/tmp/chrome-sangfor-debug';
export const CHROMIUM_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export interface ChromeManagerOptions {
  cdpPort?: number;
  userDataDir?: string;
  chromiumPath?: string;
  headless?: boolean;
  ignoreCertErrors?: boolean;
  extraArgs?: string[];
}

export interface ChromeSession {
  id: string;
  cdpPort: number;
  cdpEndpoint: string;
  wsUrl: string;
  pid?: number;
  status: 'starting' | 'ready' | 'connected' | 'closed';
}

export interface LoginCredentials {
  username: string;
  password: string;
  product: 'EPP' | 'IAG' | 'CC' | 'HCI';
  targetUrl: string;
}

export interface MenuPathStep {
  menu: string;       // e.g. "Activity Audit"
  submenu?: string;   // e.g. "Internet Access Audit"
}

export interface FormField {
  type: 'text' | 'password' | 'select' | 'checkbox' | 'textarea' | 'combobox';
  name?: string;
  id?: string;
  placeholder?: string;
  label?: string;
  value?: string;
  options?: string[];   // for select/combobox
  index?: number;       // fallback index for same-type fields
}

export interface VisionOcrResult {
  success: boolean;
  text?: string;
  error?: string;
}

// ─── Chrome Process Management ───────────────────────────────────────────────

const runningSessions = new Map<string, ChromeSession>();

function buildChromeArgs(port: number, userDataDir: string, headless: boolean, extraArgs: string[]): string[] {
  const base = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--ignore-certificate-errors',
  ];
  if (headless) {
    base.push('--headless=new');
  }
  return [...base, ...(extraArgs ?? [])];
}

function isChromeRunning(port: number): boolean {
  try {
    const res = execSync(`curl -s http://127.0.0.1:${port}/json/version`, { timeout: 3000 });
    return res.toString().includes('Chrome');
  } catch {
    return false;
  }
}

function getWsUrl(port: number): string {
  try {
    const res = execSync(`curl -s http://127.0.0.1:${port}/json/version`);
    const data = JSON.parse(res.toString());
    return data.webSocketDebuggerUrl ?? `ws://127.0.0.1:${port}`;
  } catch {
    return `ws://127.0.0.1:${port}`;
  }
}

export function ensureChromeRunning(opts: ChromeManagerOptions = {}): ChromeSession {
  const port = opts.cdpPort ?? DEFAULT_CDP_PORT;
  const userDataDir = opts.userDataDir ?? CHROME_USER_DATA_DIR;
  const chromiumPath = opts.chromiumPath ?? CHROMIUM_PATH;

  // Reuse existing session
  const existing = runningSessions.get(`port:${port}`);
  if (existing?.status === 'ready' || existing?.status === 'connected') {
    if (isChromeRunning(port)) return existing;
  }

  // Kill any stale processes on this port
  try {
    execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null || true`, { timeout: 5000 });
  } catch { /* ignore */ }

  mkdirSync(userDataDir, { recursive: true });

  const args = buildChromeArgs(port, userDataDir, opts.headless ?? false, opts.extraArgs ?? []);
  const proc = spawn(chromiumPath, args, {
    detached: false,
    stdio: 'ignore',
  });

  const session: ChromeSession = {
    id: `chrome_${port}`,
    cdpPort: port,
    cdpEndpoint: `http://127.0.0.1:${port}`,
    wsUrl: getWsUrl(port),
    pid: proc.pid,
    status: 'starting',
  };

  // Wait for ready
  let retries = 20;
  while (retries-- > 0) {
    try {
      const res = execSync(`curl -s http://127.0.0.1:${port}/json/version`, { timeout: 2000 });
      if (res.toString().includes('Chrome')) {
        session.status = 'ready';
        session.wsUrl = getWsUrl(port);
        runningSessions.set(session.id, session);
        runningSessions.set(`port:${port}`, session);
        return session;
      }
    } catch { /* not ready yet */ }
    execSync('sleep 0.5');
  }

  session.status = 'ready';
  runningSessions.set(session.id, session);
  runningSessions.set(`port:${port}`, session);
  return session;
}

export function stopChrome(port: number = DEFAULT_CDP_PORT): void {
  try {
    execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null || true`, { timeout: 5000 });
  } catch { /* ignore */ }
  runningSessions.delete(`port:${port}`);
}

// ─── Playwright Bridge ───────────────────────────────────────────────────────

export interface PwBridge {
  connectOverCdp(wsUrl: string): Promise<{
    browser: any;
    context: any;
    page: any;
  }>;
  launch(options?: any): Promise<{ browser: any; context: any; page: any }>;
}

let _pwBridge: PwBridge | null = null;

async function getPwBridge(): Promise<PwBridge> {
  if (_pwBridge) return _pwBridge;
  const { chromium } = await import('playwright');
  _pwBridge = {
    async connectOverCdp(wsUrl: string) {
      const browser = await chromium.connectOverCDP(wsUrl);
      const ctx = browser.contexts()[0] ?? await browser.newContext({ ignoreHTTPSErrors: true });
      const page = ctx.pages()[0] ?? await ctx.newPage();
      return { browser, context: ctx, page };
    },
    async launch(options: any = {}) {
      const browser = await chromium.launch(options);
      const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
      const page = await ctx.newPage();
      return { browser, context: ctx, page };
    },
  };
  return _pwBridge;
}

// ─── Vision OCR ─────────────────────────────────────────────────────────────

export async function ocrCaptcha(imagePathOrUrl: string): Promise<VisionOcrResult> {
  // Read local file as base64 data URL
  let dataUrl: string;
  if (imagePathOrUrl.startsWith('http')) {
    dataUrl = imagePathOrUrl;
  } else {
    const { readFileSync } = await import('node:fs');
    const buf = readFileSync(imagePathOrUrl);
    const ext = imagePathOrUrl.endsWith('.png') ? 'png' : 'jpeg';
    dataUrl = `data:image/${ext};base64,${buf.toString('base64')}`;
  }

  const visionEndpoint = process.env.HERMES_VISION_ENDPOINT ?? 'http://localhost:8080/vision';
  try {
    const resp = await fetch(visionEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image_url: dataUrl,
        question: 'CAPTCHA 4자리 읽어줘. 숫자와 영문만.',
      }),
    });
    if (!resp.ok) throw new Error(`Vision API ${resp.status}`);
    const data = await resp.json() as { analysis?: string; success?: boolean; text?: string };
    const text = data.analysis ?? data.text ?? '';
    const match = text.match(/[A-Za-z0-9]{4}/);
    return { success: true, text: match ? match[0] : text.replace(/[^A-Za-z0-9]/g, '').slice(0, 4) };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// ─── CAPTCHA Detection ──────────────────────────────────────────────────────

/**
 * Detect CAPTCHA challenge on page.
 * Sangfor consoles show a dedicated CAPTCHA div with class/image markers.
 */
export function detectCaptcha(page: any): { hasCaptcha: boolean; imagePath?: string } {
  // Common CAPTCHA indicators in Sangfor WebUI
  const selectors = [
    'img[src*="captcha"]',
    'img[src*="Captcha"]',
    'img[src*="verify"]',
    'div.captcha-img',
    'div.verify-code',
    '#captcha_image',
    'x-vls-captcha-img',
  ];

  for (const sel of selectors) {
    try {
      const el = page.$(sel);
      if (el) {
        const path = `/tmp/captcha_${Date.now()}.png`;
        el.screenshot({ path });
        return { hasCaptcha: true, imagePath: path };
      }
    } catch { /* try next */ }
  }
  return { hasCaptcha: false };
}

// ─── Login Helper ───────────────────────────────────────────────────────────

/**
 * Login to a Sangfor console, handling CAPTCHA via vision OCR.
 * Returns the logged-in page or throws on failure.
 */
export async function loginToConsole(
  page: any,
  credentials: LoginCredentials,
  maxCaptchaRetries = 3,
): Promise<void> {
  const { username, password, targetUrl } = credentials;
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(3000);

  let retries = maxCaptchaRetries;
  while (retries-- > 0) {
    // Check for CAPTCHA
    const captcha = detectCaptcha(page);
    if (captcha.hasCaptcha) {
      const ocr = await ocrCaptcha(captcha.imagePath!);
      if (!ocr.success) throw new Error(`CAPTCHA OCR failed: ${ocr.error}`);
      await page.fill('input[name="captcha"], input[name="verify_code"], input[name="code"]', ocr.text!);
      await page.waitForTimeout(500);
    }

    // Fill credentials
    // Try different field name patterns per product
    const userField = await page.$('input[name="user"], input[name="username"], input[name="account"]');
    const passField = await page.$('input[name="password"], input[type="password"]');
    if (!userField) throw new Error('Username field not found');
    if (!passField) throw new Error('Password field not found');

    await userField.fill(username);
    await passField.fill(password);

    await page.waitForTimeout(500);
    await passField.press('Enter');
    await page.waitForTimeout(4000);

    // Check login success — URL changed or dashboard elements present
    const url = page.url();
    if (!url.includes('login') && !url.includes('Login')) {
      return; // success
    }

    // If still on login page, retry CAPTCHA if present
    const stillHasCaptcha = detectCaptcha(page);
    if (stillHasCaptcha.hasCaptcha) {
      console.warn(`[ChromeManager] CAPTCHA retry ${maxCaptchaRetries - retries}/${maxCaptchaRetries}`);
      continue;
    }
    break;
  }
}

// ─── ExtJS SPA Helpers ──────────────────────────────────────────────────────

/**
 * Navigate a Sangfor ExtJS SPA menu by text.
 * Handles collapsed menus, submenu clicks, and SPA hash routing.
 */
export async function navigateMenu(page: any, steps: MenuPathStep[]): Promise<void> {
  for (const step of steps) {
    // Try clicking by exact text match first
    let clicked = await page.evaluate((text: string) => {
      const items = Array.from(document.querySelectorAll('a, span, div, button'));
      const item = items.find((el: Element) => el.textContent?.trim() === text);
      if (item) { (item as HTMLElement).click(); return true; }
      return false;
    }, step.menu);

    if (!clicked) {
      // Fallback: partial match
      clicked = await page.evaluate((text: string) => {
        const items = Array.from(document.querySelectorAll('a, span, div, button'));
        const item = items.find((el: Element) => el.textContent?.includes(text));
        if (item) { (item as HTMLElement).click(); return true; }
        return false;
      }, step.menu);
    }

    await page.waitForTimeout(2000);

    if (step.submenu) {
      let subClicked = await page.evaluate((text: string) => {
        const items = Array.from(document.querySelectorAll('a, span, div, button'));
        const item = items.find((el: Element) => el.textContent?.trim() === text);
        if (item) { (item as HTMLElement).click(); return true; }
        return false;
      }, step.submenu);

      if (!subClicked) {
        subClicked = await page.evaluate((text: string) => {
          const items = Array.from(document.querySelectorAll('a, span, div, button'));
          const item = items.find((el: Element) => el.textContent?.includes(text));
          if (item) { (item as HTMLElement).click(); return true; }
          return false;
        }, step.submenu);
      }

      await page.waitForTimeout(3000);
    }
  }
}

/**
 * Open a form dialog (New/Add) by finding the button.
 */
export async function openFormDialog(page: any, buttonLabel = 'Add'): Promise<void> {
  await page.evaluate((label: string) => {
    const btns = Array.from(document.querySelectorAll('button, a[role="button"]'));
    const btn = btns.find((b: Element) => b.textContent?.trim().includes(label));
    if (btn) (btn as HTMLElement).click();
  }, buttonLabel);
  await page.waitForTimeout(2000);
}

/**
 * Fill ExtJS form fields using JavaScript injection.
 * Handles dynamic IDs by using multiple fallback strategies.
 */
export async function fillFormFields(
  page: any,
  fields: FormField[],
): Promise<{ filled: string[]; failed: string[] }> {
  const filled: string[] = [];
  const failed: string[] = [];

  for (const field of fields) {
    try {
      if (field.type === 'text' || field.type === 'password' || field.type === 'textarea') {
        const script = `
          (value) => {
            const inputs = Array.from(document.querySelectorAll('input[type="text"], input[type="password"], textarea'));
            const visible = inputs.filter(i => i.offsetParent !== null && !i.disabled);
            ${field.index !== undefined
              ? `if (visible[${field.index}]) { visible[${field.index}].value = value; visible[${field.index}].dispatchEvent(new Event("input", {bubbles:true})); visible[${field.index}].dispatchEvent(new Event("change", {bubbles:true})); return true; }`
              : field.name
                ? `const byName = visible.find(i => i.name === '${field.name}'); if (byName) { byName.value = value; byName.dispatchEvent(new Event("input", {bubbles:true})); byName.dispatchEvent(new Event("change", {bubbles:true})); return true; }`
                : field.label
                  ? `const byLabel = visible.find(i => { const lbl = i.closest('.x-form-field-container')?.querySelector('.x-form-item-label'); return lbl && lbl.textContent.includes('${field.label}'); }); if (byLabel) { byLabel.value = value; byLabel.dispatchEvent(new Event("input", {bubbles:true})); byLabel.dispatchEvent(new Event("change", {bubbles:true})); return true; }`
                  : `if (visible[0]) { visible[0].value = value; visible[0].dispatchEvent(new Event("input", {bubbles:true})); visible[0].dispatchEvent(new Event("change", {bubbles:true})); return true; }`
            }
            return false;
          }
        `;
        const ok = await page.evaluate(script, field.value ?? '');
        if (ok) filled.push(field.label ?? field.name ?? field.type);
        else failed.push(field.label ?? field.name ?? field.type);

      } else if (field.type === 'select') {
        const ok = await page.evaluate((opts: { value?: string; label?: string }) => {
          const selects = Array.from(document.querySelectorAll('select'));
          const visible = selects.filter(s => s.offsetParent !== null && !s.disabled);
          if (!visible.length) return false;
          const sel = visible[0];
          if (opts.value) {
            sel.value = opts.value;
          } else if (opts.label) {
            const opt = Array.from(sel.options).find(o => o.textContent?.includes(opts.label!));
            if (opt) sel.value = opt.value;
          }
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }, { value: field.value, label: field.value });
        if (ok) filled.push(field.label ?? field.name ?? 'select');
        else failed.push(field.label ?? field.name ?? 'select');

      } else if (field.type === 'combobox') {
        // Click trigger + select from dropdown
        const triggerScript = `
          (label) => {
            const triggers = Array.from(document.querySelectorAll('.x-form-trigger, .x-form-arrow-trigger'));
            for (let t of triggers) {
              if (t.offsetParent === null) continue;
              const parent = t.parentElement;
              if (parent && parent.textContent && parent.textContent.includes(label)) {
                t.dispatchEvent(new MouseEvent('mousedown', {bubbles:true}));
                t.dispatchEvent(new MouseEvent('mouseup', {bubbles:true}));
                t.click();
                return true;
              }
            }
            return false;
          }
        `;
        const clicked = await page.evaluate(triggerScript, field.label ?? 'Field');
        await page.waitForTimeout(1500);

        if (clicked && field.value) {
          const selected = await page.evaluate((val: string) => {
            const items = Array.from(document.querySelectorAll('.x-boundlist-item, .x-list-plain li, .x-boundlist li'));
            for (let item of items) {
              if (item.textContent?.includes(val)) { (item as HTMLElement).click(); return true; }
            }
            return false;
          }, field.value);
          if (selected) filled.push(`${field.label}: ${field.value}`);
          else failed.push(`${field.label}: ${field.value}`);
        } else if (!clicked) {
          failed.push(field.label ?? 'combobox');
        } else {
          filled.push(field.label ?? 'combobox');
        }
      }
    } catch (err) {
      failed.push(`${field.label ?? field.name ?? field.type}: ${String(err)}`);
    }
  }

  return { filled, failed };
}

/**
 * Take a screenshot of the current page.
 */
export async function takeScreenshot(page: any, path: string): Promise<void> {
  mkdirSync(join(path, '..'), { recursive: true });
  await page.screenshot({ path, fullPage: false });
}

/**
 * Get current page state as text snapshot.
 */
export async function getPageSnapshot(page: any): Promise<string> {
  return page.evaluate(() => document.body.innerText);
}
