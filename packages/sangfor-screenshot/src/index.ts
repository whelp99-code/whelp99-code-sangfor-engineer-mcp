import { join } from 'node:path';
import type { BrowserExecutionPort } from '../../sangfor-browser-contracts/src/index.js';
import { resolveConfinedOutputDir } from './console-evidence-paths.js';

export * from './console-evidence.js';

export interface ScreenshotOptions {
  product: 'EPP' | 'IAG' | 'CC';
  targetUrl?: string;
  outputDir?: string;
  menus?: Array<{ menu: string; submenu?: string }>;
  dryRun?: boolean;
  sessionId?: string;
  executionPort?: BrowserExecutionPort;
  materializeArtifact?: (artifactRef: string, destinationPath: string) => Promise<void>;
}

export interface ScreenshotResult {
  product: string;
  outputDir: string;
  captured: string[];
  failed: Array<{ menu: string; error: string }>;
  totalScreenshots: number;
  timestamp: string;
}

interface ProductConfig {
  defaultUrl: string;
  menus: Array<{ menu: string; submenu?: string }>;
}

const PRODUCT_CONFIGS: Record<ScreenshotOptions['product'], ProductConfig> = {
  EPP: {
    defaultUrl: process.env.SANGFOR_EPP_URL ?? 'https://192.0.2.10',
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
    defaultUrl: process.env.SANGFOR_IAG_URL ?? 'https://192.0.2.11',
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
    defaultUrl: process.env.SANGFOR_CC_URL ?? 'https://192.0.2.12',
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

export function resolveProductScreenshotTargetUrl(
  product: ScreenshotOptions['product'],
  targetUrl?: string,
): string {
  return targetUrl ?? PRODUCT_CONFIGS[product].defaultUrl;
}

function screenshotFileStem(menu: { menu: string; submenu?: string }): string {
  const label = `${menu.menu}${menu.submenu ? `_${menu.submenu}` : ''}`
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^\.+|\.+$/g, '');
  return label || 'capture';
}

export async function captureProductScreenshots(
  options: ScreenshotOptions,
): Promise<ScreenshotResult> {
  const config = PRODUCT_CONFIGS[options.product];
  const targetUrl = resolveProductScreenshotTargetUrl(options.product, options.targetUrl);
  const menus = options.menus ?? config.menus;
  const outputDir = resolveConfinedOutputDir(
    options.outputDir ?? join('screenshots', options.product),
  );
  if (options.dryRun) {
    return {
      product: options.product,
      outputDir,
      captured: menus.map((menu) => `[dry-run] ${menu.menu}${menu.submenu ? ` > ${menu.submenu}` : ''}`),
      failed: [],
      totalScreenshots: menus.length,
      timestamp: new Date().toISOString(),
    };
  }
  if (!options.executionPort || !options.sessionId) {
    return {
      product: options.product,
      outputDir,
      captured: [],
      failed: [{
        menu: 'browser_execution_port',
        error: 'BROWSER_EXECUTION_PORT_REQUIRED: screenshot capture requires JM runtime composition.',
      }],
      totalScreenshots: 0,
      timestamp: new Date().toISOString(),
    };
  }
  const captured: string[] = [];
  const failed: Array<{ menu: string; error: string }> = [];
  for (const [index, menu] of menus.entries()) {
    const result = await options.executionPort.execute({
      schemaVersion: 'browser-execution-request.v1',
      requestId: `product-screenshot-${options.product}-${index}`,
      sessionId: options.sessionId,
      origin: new URL(targetUrl).origin,
      operation: {
        kind: 'capture_console_evidence',
        captureId: `${options.product}-${index}`,
        menuPath: [menu],
      },
    });
    if (result.status === 'PASS' && result.evidence.length > 0) {
      if (!options.materializeArtifact) {
        failed.push({
          menu: menu.submenu ? `${menu.menu} > ${menu.submenu}` : menu.menu,
          error: 'BROWSER_ARTIFACT_MATERIALIZER_REQUIRED: screenshot output files require JM runtime composition.',
        });
        continue;
      }
      try {
        for (const [artifactIndex, item] of result.evidence.entries()) {
          const suffix = result.evidence.length > 1 ? `_${artifactIndex + 1}` : '';
          const filePath = join(
            outputDir,
            `${String(index + 1).padStart(2, '0')}_${screenshotFileStem(menu)}${suffix}.png`,
          );
          await options.materializeArtifact(item.artifactRef, filePath);
          captured.push(filePath);
        }
      } catch (error) {
        failed.push({
          menu: menu.submenu ? `${menu.menu} > ${menu.submenu}` : menu.menu,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else {
      failed.push({
        menu: menu.submenu ? `${menu.menu} > ${menu.submenu}` : menu.menu,
        error: result.error?.message ?? `Capture result: ${result.status}`,
      });
    }
  }
  return {
    product: options.product,
    outputDir,
    captured,
    failed,
    totalScreenshots: captured.length,
    timestamp: new Date().toISOString(),
  };
}
