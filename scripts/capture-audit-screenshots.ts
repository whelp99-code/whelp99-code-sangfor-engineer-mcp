/**
 * 실장비 스크린샷 캡처 — 감사 항목별 메뉴 캡처
 * Chrome CDP (port 9333)에 연결하여 EPP/IAG/CC 콘솔 메뉴를 순회하며 캡처
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const reqPass = (k: string): string => { const v = process.env[k]; if (!v) { console.error(`missing env: ${k}`); process.exit(1); } return v; };

const CDP_URL = 'http://127.0.0.1:9333';
const OUT_DIR = '/Users/jmpark/Documents/Playground/whelp99-code-sangfor-engineer-mcp/outputs/final_images';

// Device info
const DEVICES = {
  epp: { url: 'https://10.80.1.106', user: 'admin', pass: reqPass('SANGFOR_EPP_PASSWORD') },
  iag: { url: 'https://10.80.1.108', user: 'admin', pass: reqPass('SANGFOR_IAG_PASSWORD') },
  cc:  { url: 'https://10.80.1.107', user: 'admin', pass: reqPass('SANGFOR_CC_PASSWORD') },
};

// Screenshots to capture per product
const CAPTURES: Array<{ product: keyof typeof DEVICES; no: number; name: string; path: string; nav: (page: any) => Promise<void> }> = [
  // ── EPP (Endpoint Secure) ──
  { product: 'epp', no: 3,  name: 'Agent Status (Dashboard)',       path: 'epp/01_dashboard.png',     nav: async (p) => { await p.goto(`${DEVICES.epp.url}/#/dashboard`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {}); await p.waitForTimeout(3000); } },
  { product: 'epp', no: 4,  name: 'Anti-Malware Policy',            path: 'epp/02_anti_malware.png',   nav: async (p) => { await p.goto(`${DEVICES.epp.url}/#/policy/antiMalware`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {}); await p.waitForTimeout(3000); } },
  { product: 'epp', no: 5,  name: 'Scan Tasks',                     path: 'epp/03_scan_tasks.png',     nav: async (p) => { await p.goto(`${DEVICES.epp.url}/#/scan`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {}); await p.waitForTimeout(3000); } },
  { product: 'epp', no: 8,  name: 'App Control',                    path: 'epp/04_app_control.png',    nav: async (p) => { await p.goto(`${DEVICES.epp.url}/#/policy/appControl`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {}); await p.waitForTimeout(3000); } },
  { product: 'epp', no: 10, name: 'Device Control',                 path: 'epp/05_device_control.png', nav: async (p) => { await p.goto(`${DEVICES.epp.url}/#/policy/deviceControl`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {}); await p.waitForTimeout(3000); } },
  { product: 'epp', no: 7,  name: 'Security Events',                path: 'epp/06_security_events.png', nav: async (p) => { await p.goto(`${DEVICES.epp.url}/#/event`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {}); await p.waitForTimeout(3000); } },
  { product: 'epp', no: 29, name: 'Agent Deployment',               path: 'epp/07_agent_deploy.png',   nav: async (p) => { await p.goto(`${DEVICES.epp.url}/#/deployment`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {}); await p.waitForTimeout(3000); } },

  // ── IAG ──
  { product: 'iag', no: 12, name: 'DLP Policies',                   path: 'iag/01_dlp_policies.png',   nav: async (p) => { await p.goto(`${DEVICES.iag.url}/#/activityAudit/dlpPolicy`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {}); await p.waitForTimeout(3000); } },
  { product: 'iag', no: 13, name: 'DLP Events / Logs',              path: 'iag/02_dlp_events.png',     nav: async (p) => { await p.goto(`${DEVICES.iag.url}/#/activityAudit/dlpEvent`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {}); await p.waitForTimeout(3000); } },
  { product: 'iag', no: 14, name: 'Access Policy (NAC)',             path: 'iag/03_access_policy.png',  nav: async (p) => { await p.goto(`${DEVICES.iag.url}/#/onlineActivities/accessPolicy`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {}); await p.waitForTimeout(3000); } },
  { product: 'iag', no: 15, name: 'Endpoint Compliance',             path: 'iag/04_endpoint_compliance.png', nav: async (p) => { await p.goto(`${DEVICES.iag.url}/#/authentication/endpointCompliance`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {}); await p.waitForTimeout(3000); } },
  { product: 'iag', no: 16, name: 'Internet Access Logs',            path: 'iag/05_internet_logs.png',  nav: async (p) => { await p.goto(`${DEVICES.iag.url}/#/logs/internetAccess`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {}); await p.waitForTimeout(3000); } },

  // ── CC (Cyber Command / NDR) ──
  { product: 'cc', no: 17, name: 'Dashboard / Log Sources',          path: 'cc/01_dashboard.png',       nav: async (p) => { await p.goto(`${DEVICES.cc.url}/#/dashboard`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {}); await p.waitForTimeout(4000); } },
  { product: 'cc', no: 18, name: 'Detection Logs',                   path: 'cc/02_detection_logs.png',  nav: async (p) => { await p.goto(`${DEVICES.cc.url}/#/detection/logs`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {}); await p.waitForTimeout(4000); } },
  { product: 'cc', no: 19, name: 'Detection Threats',                path: 'cc/03_threats.png',         nav: async (p) => { await p.goto(`${DEVICES.cc.url}/#/detection/threats`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {}); await p.waitForTimeout(4000); } },
  { product: 'cc', no: 20, name: 'Alert / Notification',             path: 'cc/04_alerts.png',          nav: async (p) => { await p.goto(`${DEVICES.cc.url}/#/response`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {}); await p.waitForTimeout(4000); } },
];

async function main() {
  console.log('Connecting to Chrome CDP...');
  const browser = await chromium.connectOverCDP(CDP_URL);
  const contexts = browser.contexts();
  if (contexts.length === 0) {
    console.error('No browser context found');
    process.exit(1);
  }
  const context = contexts[0];

  // Ensure output dirs exist
  mkdirSync(join(OUT_DIR, 'epp'), { recursive: true });
  mkdirSync(join(OUT_DIR, 'iag'), { recursive: true });
  mkdirSync(join(OUT_DIR, 'cc'), { recursive: true });

  let success = 0;
  let failed = 0;

  for (const cap of CAPTURES) {
    console.log(`\n[${cap.product.toUpperCase()}] 감사 #${cap.no}: ${cap.name}`);
    try {
      // Create a new page for each capture to avoid state issues
      const page = await context.newPage();

      // Navigate to the menu
      await cap.nav(page);

      // Take screenshot
      const outPath = join(OUT_DIR, cap.path);
      await page.screenshot({ path: outPath, fullPage: false });
      console.log(`  ✅ saved: ${cap.path}`);
      success++;

      await page.close();
    } catch (err: any) {
      console.log(`  ❌ failed: ${err.message?.substring(0, 80)}`);
      failed++;
    }
  }

  console.log(`\n=== 완료: 성공 ${success}, 실패 ${failed} ===`);
  browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
