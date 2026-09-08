import { captureProductScreenshotsWithJm, requiredBrowserExecutionPort, requiredBrowserArtifactMaterializer } from './browser-runtime-composition.js';
import { normalizeProduct, resolveEngagementScopedData } from '../../../packages/shared/src/index.js';
import { formatDateStamp as formatCaptureDateStamp, buildCaptureRelativeDir, resolveConfinedOutputDir, DEFAULT_CONSOLE_CDP_PORT, captureConsoleEvidence, verifyCaptureLedger } from '../../../packages/sangfor-screenshot/src/index.js';
import { join } from 'node:path';
import { startOperatorSession, closeOperatorSession } from '../../../packages/sangfor-operator/src/index.js';
import { isSafeRunId } from '../../../packages/sangfor-evidence/src/index.js';
import { mkdirSync } from 'node:fs';
import { buildSettingGuideDocx, buildOperationsGuideDocx, buildComprehensiveSettingGuideDocx, buildComprehensiveOperationsGuideDocx } from '../../../packages/sangfor-product-adapters/src/index.js';
import { buildSettingGuidePptx, buildOperationsGuidePptx } from '../../../packages/sangfor-pptx/src/index.js';
import type { ToolCatalogEntry } from './mcp-contracts.js';

export const captureToolCatalog: readonly ToolCatalogEntry[] = [
  ["sangfor_capture_screenshots", {
    description: 'Capture screenshots from Sangfor product consoles (EPP, IAG, CC) via Chrome CDP. Connects to the product console, logs in, navigates menus, and saves screenshots.',
    inputSchema: { type: 'object', properties: { product: { type: 'string', enum: ['EPP', 'IAG', 'CC'], description: 'Product to capture screenshots from' }, targetUrl: { type: 'string', description: 'Override target URL' }, username: { type: 'string', description: 'Login username' }, password: { type: 'string', description: 'Login password' }, outputDir: { type: 'string', description: 'Output directory for screenshots' }, cdpPort: { type: 'number', description: 'Optional loopback Chrome CDP port' }, headless: { type: 'boolean', description: 'Run Chrome in headless mode' }, dryRun: { type: 'boolean', description: 'Dry-run mode: skip Chrome and just list planned screenshots' } }, required: ['product'] },
    handler: captureProductScreenshotsWithJm,
  }],
  ["sangfor_console_capture_evidence", {
    description: 'Read-only console evidence capture: attaches to a Chrome you already have open on the product console (via a trusted SANGFOR_JM_CDP_PROFILES_JSON port/origin binding; never launches a browser) and screenshots the listed menus/URLs as named audit evidence (REQ##_product_menu_Before_YYYYMMDD.png), hash-chained into the AuditLedger. reads console screens only; never changes device configuration. Chrome must already be running with --remote-debugging-port=<cdpPort> (default 9222). Omit outputDir to use the engagement-scoped default data/evidence/captures/<YYYYMMDD>/.',
    inputSchema: {
      type: 'object',
      properties: {
        cdpPort: { type: 'number', description: 'Chrome remote-debugging port to attach to. Default 9222.' },
        product: { type: 'string', description: 'Product code, e.g. ENDPOINT_SECURE, IAG, CYBER_COMMAND, HCI_SCP (see sangfor_products). Aliases like EPP/CC are also accepted.' },
        captures: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              reqId: { type: 'string', description: 'ITAC requirement id, e.g. "01" — becomes REQ01 in the filename.' },
              menuLabel: { type: 'string', description: 'Human label for the console screen; used in the filename.' },
              menuPath: {
                type: 'array',
                items: { type: 'object', properties: { menu: { type: 'string' }, submenu: { type: 'string' } }, required: ['menu'] },
                description: 'Optional menu/submenu text-click path (read-only navigation only — no form submission).',
              },
              url: { type: 'string', description: 'Optional URL to navigate to before capture.' },
            },
            required: ['reqId', 'menuLabel'],
          },
        },
        outputDir: { type: 'string', description: 'Output directory for PNGs. Omit for the engagement-scoped default.' },
        dateStamp: { type: 'string', description: 'Override the YYYYMMDD stamp used in filenames and the default outputDir. Default: today.' },
        deviceId: { type: 'string', description: 'Which appliance these captures came from, e.g. iag-hq-01. Separates two devices of the same product within one customer engagement: adds a <deviceId> folder under the date and a device token to each filename. Omit when unknown.' },
        engagementId: { type: 'string', description: 'Optional engagement id recorded in the ledger payload.' },
      },
      required: ['product', 'captures'],
    },
    handler: async (args: { cdpPort?: number; product: string; captures: Array<{ reqId: string; menuLabel: string; menuPath?: Array<{ menu: string; submenu?: string }>; url?: string }>; outputDir?: string; dateStamp?: string; engagementId?: string; deviceId?: string }) => {
      const product = normalizeProduct(args.product);
      const dateStamp = args.dateStamp ?? formatCaptureDateStamp(new Date());
      // customer (engagement-scoped root) / date / device
      const outputDir = args.outputDir ?? join(resolveEngagementScopedData('data/evidence', 'SANGFOR_EVIDENCE_ROOT'), buildCaptureRelativeDir(dateStamp, args.deviceId));
      resolveConfinedOutputDir(outputDir);
      const targetUrl = args.captures.find((capture) => capture.url)?.url
        ?? process.env.SANGFOR_CONSOLE_URL
        ?? 'http://127.0.0.1:3400';
      const cdpPort = args.cdpPort ?? DEFAULT_CONSOLE_CDP_PORT;
      const session = startOperatorSession({
        product,
        mode: 'customer_readonly',
        targetUrl,
        browser: { useLocalBrowser: true, cdpPort },
      });
      try {
        return await captureConsoleEvidence({
          product,
          captures: args.captures,
          outputDir,
          deviceId: args.deviceId,
          dateStamp,
          engagementId: args.engagementId,
        }, {
          executionPort: requiredBrowserExecutionPort(),
          sessionId: session.id,
          origin: new URL(targetUrl).origin,
          materializeArtifact: requiredBrowserArtifactMaterializer(),
        });
      } finally {
        await closeOperatorSession(session.id, requiredBrowserExecutionPort());
      }
    },
  }],
  ["sangfor_verify_capture_ledger", {
    description: 'Read-only: verify a sangfor_console_capture_evidence run — the AuditLedger hash-chain integrity (chainOk) AND, per captured file, whether its current on-disk sha256 still matches the hash recorded at capture time (tamper detection).',
    inputSchema: { type: 'object', properties: { runId: { type: 'string', description: 'runId returned by sangfor_console_capture_evidence.' } }, required: ['runId'] },
    handler: (args: { runId: string }) => {
      if (!isSafeRunId(args.runId)) return { error: `INVALID_RUN_ID: "${args.runId}" is not a safe path segment.` };
      return verifyCaptureLedger(args.runId);
    },
  }],
  ["sangfor_generate_all_guides", {
    description: 'Generate complete guide set: setting guide (docx + pptx), operations guide (docx + pptx), and optionally capture screenshots. Uses the ITAC Excel as input.',
    inputSchema: { type: 'object', properties: { filePath: { type: 'string', description: 'Path to the ITAC Excel (.xlsx) file' }, outputDir: { type: 'string', description: 'Output directory for all guides' }, screenshotDir: { type: 'string', description: 'Directory containing product screenshots (default: outputs/final_images)' }, captureScreenshots: { type: 'boolean', description: 'Also capture product console screenshots' }, screenshotProducts: { type: 'array', items: { type: 'string' }, description: 'Products to capture screenshots for (EPP, IAG, CC)' } }, required: ['filePath'] },
    handler: async (args: { filePath: string; outputDir?: string; screenshotDir?: string; captureScreenshots?: boolean; screenshotProducts?: string[] }) => {
      const outDir = args.outputDir ?? join(process.cwd(), 'outputs');
      const screenshotDir = args.screenshotDir ?? join(process.cwd(), 'outputs', 'final_images');
      mkdirSync(outDir, { recursive: true });
      const results: Record<string, unknown> = {};
      try {
        results.settingDocx = await buildSettingGuideDocx({ filePath: args.filePath, outputPath: join(outDir, 'Sangfor_설정가이드_MCP.docx') });
      } catch (err) { results.settingDocxError = String(err); }
      try {
        results.settingPptx = await buildSettingGuidePptx({ filePath: args.filePath, outputPath: join(outDir, 'Sangfor_설정가이드_MCP.pptx') });
      } catch (err) { results.settingPptxError = String(err); }
      try {
        results.operationsPptx = await buildOperationsGuidePptx({ outputPath: join(outDir, 'Sangfor_운영가이드_MCP.pptx') });
      } catch (err) { results.operationsPptxError = String(err); }
      try {
        results.operationsDocx = await buildOperationsGuideDocx({ outputPath: join(outDir, 'Sangfor_운영가이드_MCP.docx') });
      } catch (err) { results.operationsDocxError = String(err); }
      try {
        results.comprehensiveSettingDocx = await buildComprehensiveSettingGuideDocx({ filePath: args.filePath, outputPath: join(outDir, 'Sangfor_설정가이드_v6_종합메뉴얼.docx'), screenshotDir });
      } catch (err) { results.comprehensiveSettingDocxError = String(err); }
      try {
        results.comprehensiveOpsDocx = await buildComprehensiveOperationsGuideDocx({ outputPath: join(outDir, 'Sangfor_운영가이드_v6_종합메뉴얼.docx'), screenshotDir });
      } catch (err) { results.comprehensiveOpsDocxError = String(err); }
      if (args.captureScreenshots) {
        const products = args.screenshotProducts ?? ['EPP', 'IAG', 'CC'];
        results.screenshots = {};
        for (const product of products) {
          try {
            (results.screenshots as Record<string, unknown>)[product] = await captureProductScreenshotsWithJm({
              product: product as 'EPP' | 'IAG' | 'CC',
              outputDir: join('guide-screenshots', product),
              username: process.env[`SANGFOR_${product}_USERNAME`],
              password: process.env[`SANGFOR_${product}_PASSWORD`],
            });
          } catch (err) {
            (results.screenshots as Record<string, unknown>)[product] = { error: String(err) };
          }
        }
      }
      return results;
    }
  }],
];
