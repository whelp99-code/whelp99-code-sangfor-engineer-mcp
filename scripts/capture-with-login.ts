/**
 * 실장비 스크린샷 캡처 — 로그인 포함 (EPP CAPTCHA 자동 읽기)
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const reqPass = (k: string): string => { const v = process.env[k]; if (!v) { console.error(`missing env: ${k}`); process.exit(1); } return v; };

const CDP_URL = 'http://127.0.0.1:9333';
const OUT_DIR = '/Users/jmpark/Documents/Playground/whelp99-code-sangfor-engineer-mcp/outputs/final_images';

const DEVICES = {
  epp: { url: 'https://10.80.1.106', user: 'admin', pass: reqPass('SANGFOR_EPP_PASSWORD') },
  iag: { url: 'https://10.80.1.108', user: 'admin', pass: reqPass('SANGFOR_IAG_PASSWORD') },
  cc:  { url: 'https://10.80.1.107', user: 'admin', pass: reqPass('SANGFOR_CC_PASSWORD') },
};

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ── EPP Login (with CAPTCHA) ──
async function loginEPP(page: any): Promise<boolean> {
  console.log('  EPP 로그인 페이지 접속...');
  await page.goto(DEVICES.epp.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(5000);

  // Username
  await page.fill('#user', DEVICES.epp.user);
  await sleep(300);

  // Password
  await page.fill('#password', DEVICES.epp.pass);
  await sleep(300);

  // CAPTCHA 이미지 스크린샷 (vision_analyze용)
  const captchaImg = page.locator('img[src*="randcode"]');
  if (await captchaImg.isVisible({ timeout: 3000 }).catch(() => false)) {
    const box = await captchaImg.boundingBox();
    if (box) {
      await page.screenshot({
        path: '/tmp/epp_captcha_crop.png',
        clip: { x: box.x - 5, y: box.y - 5, width: box.width + 10, height: box.height + 10 },
      });
      // Also take full login page for reference
      await page.screenshot({ path: '/tmp/epp_login_full.png' });
      console.log('  CAPTCHA 스크린샷: /tmp/epp_captcha_crop.png');
      console.log('  ⏳ CAPTCHA 코드를 읽어주세요...');
      return false; // Need external CAPTCHA reading
    }
  }

  // No CAPTCHA visible — try direct login
  await page.click('#button');
  await sleep(5000);
  console.log(`  로그인 후 URL: ${page.url()}`);
  return true;
}

async function fillCaptchaAndLogin(page: any, captchaCode: string): Promise<boolean> {
  console.log(`  CAPTCHA 입력: ${captchaCode}`);
  await page.fill('#code', captchaCode);
  await sleep(300);
  await page.click('#button');
  await sleep(5000);
  const url = page.url();
  console.log(`  로그인 후 URL: ${url}`);
  // Check if still on login page
  if (url.includes('login') || url === DEVICES.epp.url + '/' || url === DEVICES.epp.url) {
    console.log('  ❌ 로그인 실패 (CAPTCHA 오류 가능)');
    return false;
  }
  return true;
}

// ── IAG Login ──
async function loginIAG(page: any): Promise<boolean> {
  console.log('  IAG 로그인 페이지 접속...');
  await page.goto(DEVICES.iag.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(5000);

  // Try various selectors
  const userInput = page.locator('input[name="username"], input[type="text"]').first();
  const passInput = page.locator('input[type="password"]').first();

  await userInput.fill(DEVICES.iag.user).catch(() => {});
  await sleep(300);
  await passInput.fill(DEVICES.iag.pass).catch(() => {});
  await sleep(300);

  // Try submit
  const loginBtn = page.locator('input[type="button"], button[type="submit"], input[type="submit"]').first();
  await loginBtn.click().catch(async () => {
    // Fallback: try pressing Enter
    await page.keyboard.press('Enter');
  });
  await sleep(5000);

  console.log(`  로그인 후 URL: ${page.url()}`);
  return true;
}

// ── CC Login ──
async function loginCC(page: any): Promise<boolean> {
  console.log('  CC 로그인 페이지 접속...');
  await page.goto(DEVICES.cc.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(5000);

  const userInput = page.locator('input[name="username"], input[type="text"]').first();
  const passInput = page.locator('input[type="password"]').first();

  await userInput.fill(DEVICES.cc.user).catch(() => {});
  await sleep(300);
  await passInput.fill(DEVICES.cc.pass).catch(() => {});
  await sleep(300);

  const loginBtn = page.locator('input[type="button"], button[type="submit"], input[type="submit"]').first();
  await loginBtn.click().catch(async () => {
    await page.keyboard.press('Enter');
  });
  await sleep(5000);

  console.log(`  로그인 후 URL: ${page.url()}`);
  return true;
}

// ── Capture menu screenshot ──
async function captureMenu(page: any, name: string, outPath: string, waitMs = 4000) {
  await sleep(waitMs);
  await page.screenshot({ path: outPath, fullPage: false });
  const size = (await import('node:fs')).statSync(outPath).size;
  console.log(`  ✅ ${name} (${Math.round(size / 1024)}KB)`);
}

// ── Main ──
async function main() {
  console.log('Chrome CDP 연결...');
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];

  mkdirSync(join(OUT_DIR, 'epp'), { recursive: true });
  mkdirSync(join(OUT_DIR, 'iag'), { recursive: true });
  mkdirSync(join(OUT_DIR, 'cc'), { recursive: true });

  // ── EPP ──
  console.log('\n=== EPP (10.80.1.106) ===');
  const eppPage = await context.newPage();
  let eppOk = await loginEPP(eppPage);

  if (!eppOk) {
    // Need to read CAPTCHA externally — save state and exit for now
    console.log('\n  EPP CAPTCHA가 필요합니다. /tmp/epp_captcha_crop.png을 확인하세요.');
    console.log('  CAPTCHA 코드를 인자로 전달하면 자동 입력됩니다.');
    
    // Check if CAPTCHA code was passed as argument
    const captchaArg = process.argv[2];
    if (captchaArg) {
      eppOk = await fillCaptchaAndLogin(eppPage, captchaArg);
    }
  }

  if (eppOk) {
    const eppMenus = [
      { url: '/#/dashboard', name: 'Dashboard', file: 'epp/01_dashboard.png' },
      { url: '/#/policy/antiMalware', name: 'Anti-Malware Policy', file: 'epp/02_anti_malware.png' },
      { url: '/#/scan', name: 'Scan Tasks', file: 'epp/03_scan_tasks.png' },
      { url: '/#/policy/appControl', name: 'App Control', file: 'epp/04_app_control.png' },
      { url: '/#/policy/deviceControl', name: 'Device Control', file: 'epp/05_device_control.png' },
      { url: '/#/event', name: 'Security Events', file: 'epp/06_security_events.png' },
      { url: '/#/deployment', name: 'Agent Deployment', file: 'epp/07_agent_deploy.png' },
    ];
    for (const m of eppMenus) {
      await eppPage.goto(`${DEVICES.epp.url}${m.url}`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
      await captureMenu(eppPage, m.name, join(OUT_DIR, m.file), 4000);
    }
  }
  await eppPage.close();

  // ── IAG ──
  console.log('\n=== IAG (10.80.1.108) ===');
  const iagPage = await context.newPage();
  await loginIAG(iagPage);

  const iagMenus = [
    { url: '/#/activityAudit/dlpPolicy', name: 'DLP Policies', file: 'iag/01_dlp_policies.png' },
    { url: '/#/activityAudit/dlpEvent', name: 'DLP Events', file: 'iag/02_dlp_events.png' },
    { url: '/#/onlineActivities/accessPolicy', name: 'Access Policy', file: 'iag/03_access_policy.png' },
    { url: '/#/authentication/endpointCompliance', name: 'Endpoint Compliance', file: 'iag/04_endpoint_compliance.png' },
    { url: '/#/logs/internetAccess', name: 'Internet Access Logs', file: 'iag/05_internet_logs.png' },
  ];
  for (const m of iagMenus) {
    await iagPage.goto(`${DEVICES.iag.url}${m.url}`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    await captureMenu(iagPage, m.name, join(OUT_DIR, m.file), 4000);
  }
  await iagPage.close();

  // ── CC ──
  console.log('\n=== CC (10.80.1.107) ===');
  const ccPage = await context.newPage();
  await loginCC(ccPage);

  const ccMenus = [
    { url: '/#/dashboard', name: 'Dashboard', file: 'cc/01_dashboard.png' },
    { url: '/#/detection/logs', name: 'Detection Logs', file: 'cc/02_detection_logs.png' },
    { url: '/#/detection/threats', name: 'Threats', file: 'cc/03_threats.png' },
    { url: '/#/response', name: 'Response', file: 'cc/04_alerts.png' },
  ];
  for (const m of ccMenus) {
    await ccPage.goto(`${DEVICES.cc.url}${m.url}`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    await captureMenu(ccPage, m.name, join(OUT_DIR, m.file), 4000);
  }
  await ccPage.close();

  console.log('\n=== 완료 ===');
  browser.close();
}

main().catch(e => { console.error(e.message); process.exit(1); });
