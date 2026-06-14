/**
 * Sangfor Screenshot Collector — Chrome CDP-based automated screenshot capture
 * for Sangfor product consoles (EPP, IAG, CC).
 *
 * Uses @sangfor/chrome for CDP lifecycle and navigation.
 * Chrome-related imports are lazy-loaded to avoid module-level failures
 * when playwright is not installed.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ScreenshotOptions {
  product: 'EPP' | 'IAG' | 'CC';
  targetUrl?: string;
  username?: string;
  password?: string;
  outputDir?: string;
  cdpPort?: number;
  headless?: boolean;
  menus?: Array<{ menu: string; submenu?: string }>;
  dryRun?: boolean;
}

export interface ScreenshotResult {
  product: string;
  outputDir: string;
  captured: string[];
  failed: Array<{ menu: string; error: string }>;
  totalScreenshots: number;
  timestamp: string;
}

// ─── Product Defaults ───────────────────────────────────────────────────────

interface ProductConfig {
  defaultUrl: string;
  defaultUsername: string;
  defaultPassword: string;
  cdpPort: number;
  menus: Array<{ menu: string; submenu?: string }>;
}

const PRODUCT_CONFIGS: Record<string, ProductConfig> = {
  EPP: {
    defaultUrl: 'https://10.80.1.106',
    defaultUsername: 'admin',
    defaultPassword: process.env.SANGFOR_EPP_PASSWORD ?? 'sangfor',
    cdpPort: 9333,
    menus: [
      { menu: 'Dashboard' },
      { menu: 'Assets', submenu: 'Endpoint/Agent List' },
      { menu: 'Policy', submenu: 'Malware/Ransomware Protection' },
      { menu: 'Policy', submenu: 'Exceptions' },
      { menu: 'Policy', submenu: 'Device Control' },
      { menu: 'Policy', submenu: 'Software Control' },
      { menu: 'System', submenu: 'Update Management' },
      { menu: 'System', submenu: 'Syslog' },
      { menu: 'Deployment', submenu: 'Agent Deployment' },
    ],
  },
  IAG: {
    defaultUrl: 'https://10.80.1.108',
    defaultUsername: 'admin',
    defaultPassword: 'sangfor',
    cdpPort: 9334,
    menus: [
      { menu: 'Dashboard' },
      { menu: 'System', submenu: 'Interfaces' },
      { menu: 'System', submenu: 'Routing' },
      { menu: 'User Management', submenu: 'Authentication Source' },
      { menu: 'Policy', submenu: 'Access Control' },
      { menu: 'Policy', submenu: 'URL/Application Control' },
      { menu: 'Policy', submenu: 'DLP' },
      { menu: 'Logs', submenu: 'Internet Access Logs' },
      { menu: 'Logs', submenu: 'Activity Audit' },
    ],
  },
  CC: {
    defaultUrl: 'https://10.80.1.107',
    defaultUsername: 'admin',
    defaultPassword: process.env.SANGFOR_CC_PASSWORD ?? 'sangfor',
    cdpPort: 9335,
    menus: [
      { menu: 'Dashboard', submenu: 'Security Operations' },
      { menu: 'Assets', submenu: 'Sensors/Connectors' },
      { menu: 'Events', submenu: 'Event Sources' },
      { menu: 'Incidents', submenu: 'Incident List' },
      { menu: 'Alerts', submenu: 'Alert Rules' },
      { menu: 'SOAR', submenu: 'Playbooks' },
      { menu: 'System', submenu: 'Integrations' },
    ],
  },
};

// ─── Main Export ─────────────────────────────────────────────────────────────

export async function captureProductScreenshots(
  options: ScreenshotOptions,
): Promise<ScreenshotResult> {
  const product = options.product;
  const config = PRODUCT_CONFIGS[product];
  if (!config) throw new Error(`Unknown product: ${product}`);

  const targetUrl = options.targetUrl ?? config.defaultUrl;
  const username = options.username ?? config.defaultUsername;
  const password = options.password ?? config.defaultPassword;
  const cdpPort = options.cdpPort ?? config.cdpPort;
  const menus = options.menus ?? config.menus;
  const outputDir = options.outputDir ?? join(process.cwd(), 'outputs', 'screenshots', product);
  const headless = options.headless ?? false;

  mkdirSync(outputDir, { recursive: true });

  const captured: string[] = [];
  const failed: Array<{ menu: string; error: string }> = [];

  // Skip Chrome operations in dry-run mode
  if (options.dryRun) {
    return {
      product,
      outputDir,
      captured: menus.map(m => `[dry-run] ${m.menu}${m.submenu ? ` > ${m.submenu}` : ''}`),
      failed: [],
      totalScreenshots: menus.length,
      timestamp: new Date().toISOString(),
    };
  }

  try {
    // Lazy-load chrome module to avoid module-level failures
    const chrome = await import('@sangfor/chrome');
    const { chromium } = await import('playwright');

    // Ensure Chrome is running with CDP
    const session = chrome.ensureChromeRunning({
      cdpPort,
      headless,
      ignoreCertErrors: true,
    });

    // Connect via Playwright
    const browser = await chromium.connectOverCDP(session.wsUrl);
    const context = browser.contexts()[0] ?? await browser.newContext({ ignoreHTTPSErrors: true });
    const page = context.pages()[0] ?? await context.newPage();

    // Login
    const credentials = {
      username,
      password,
      product: product as 'EPP' | 'IAG' | 'CC',
      targetUrl,
    };

    try {
      await chrome.loginToConsole(page, credentials);
    } catch (loginErr) {
      failed.push({ menu: 'login', error: String(loginErr) });
      // Take login page screenshot even on failure
      const loginPath = join(outputDir, 'login_failed.png');
      try {
        await chrome.takeScreenshot(page, loginPath);
        captured.push(loginPath);
      } catch { /* ignore */ }
      return {
        product,
        outputDir,
        captured,
        failed,
        totalScreenshots: 0,
        timestamp: new Date().toISOString(),
      };
    }

    // Capture dashboard first
    try {
      const dashPath = join(outputDir, 'dashboard.png');
      await chrome.takeScreenshot(page, dashPath);
      captured.push(dashPath);
    } catch (err) {
      failed.push({ menu: 'dashboard', error: String(err) });
    }

    // Navigate to each menu and capture screenshot
    for (const menuStep of menus) {
      try {
        await chrome.navigateMenu(page, [menuStep]);
        await page.waitForTimeout(2000);

        const menuName = menuStep.submenu
          ? `${menuStep.menu}_${menuStep.submenu}`.replace(/[^a-zA-Z0-9가-힣]/g, '_')
          : menuStep.menu.replace(/[^a-zA-Z0-9가-힣]/g, '_');
        const screenshotPath = join(outputDir, `${menuName}.png`);

        await chrome.takeScreenshot(page, screenshotPath);
        captured.push(screenshotPath);
      } catch (err) {
        const menuLabel = menuStep.submenu
          ? `${menuStep.menu} > ${menuStep.submenu}`
          : menuStep.menu;
        failed.push({ menu: menuLabel, error: String(err) });
      }
    }
  } catch (err) {
    failed.push({ menu: 'chrome_setup', error: String(err) });
  }

  return {
    product,
    outputDir,
    captured,
    failed,
    totalScreenshots: captured.length,
    timestamp: new Date().toISOString(),
  };
}
