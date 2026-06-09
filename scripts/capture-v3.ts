/**
 * 실장비 스크린샷 v3 — 스크린샷→vision CAPTCHA→일괄입력→로그인→메뉴캡처
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CDP_URL = 'http://127.0.0.1:9333';
const OUT_DIR = '/Users/jmpark/Documents/Playground/whelp99-code-sangfor-engineer-mcp/outputs/final_images';
const D = {
  epp: { url: 'https://10.80.1.106', user: 'admin', pass: 'Itac123!@#' },
  iag: { url: 'https://10.80.1.108', user: 'admin', pass: 'Itac123#@!' },
  cc:  { url: 'https://10.80.1.107', user: 'admin', pass: 'Itac123!@#' },
};
const sl = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── CAPTCHA 스크린샷 → 파일 저장 (외부 vision_analyze용) ──
async function captureCaptcha(page: Page, outPath: string): Promise<boolean> {
  await page.screenshot({ path: outPath, fullPage: false });
  console.log(`  📸 로그인 화면 캡처: ${outPath}`);
  return true;
}

// ── EPP 로그인 ──
async function loginEPP(page: Page, captchaCode: string): Promise<boolean> {
  console.log('  EPP 접속...');
  await page.goto(D.epp.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sl(5000);

  // 모든 필드를 한번에 입력
  await page.fill('#user', D.epp.user);
  await page.fill('#password', D.epp.pass);
  await page.fill('#code', captchaCode);
  await sl(500);

  // 로그인 클릭
  await page.click('#button');
  await sl(6000);

  const url = page.url();
  console.log(`  URL: ${url}`);
  if (url.includes('login') || url.endsWith('/')) {
    console.log('  ❌ 로그인 실패');
    return false;
  }
  console.log('  ✅ 로그인 성공');
  return true;
}

// ── IAG 로그인 ──
async function loginIAG(page: Page): Promise<boolean> {
  console.log('  IAG 접속...');
  await page.goto(D.iag.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sl(6000);

  await page.evaluate((d: any) => {
    const els = document.querySelectorAll('input');
    for (let i = 0; i < els.length; i++) {
      if (els[i].type === 'text' || els[i].name === 'username') {
        els[i].value = d.user;
        els[i].dispatchEvent(new Event('input', { bubbles: true }));
        els[i].dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (els[i].type === 'password') {
        els[i].value = d.pass;
        els[i].dispatchEvent(new Event('input', { bubbles: true }));
        els[i].dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    const btns = document.querySelectorAll('input[type="button"], button');
    for (let i = 0; i < btns.length; i++) {
      const t = btns[i].textContent || (btns[i] as any).value || '';
      if (/login|로그인/i.test(t)) { (btns[i] as HTMLElement).click(); return; }
    }
    if (btns[0]) (btns[0] as HTMLElement).click();
  }, { user: D.iag.user, pass: D.iag.pass });

  await sl(8000);
  const url = page.url();
  console.log(`  URL: ${url}`);
  if (url.includes('login')) { console.log('  ❌ 로그인 실패'); return false; }
  console.log('  ✅ 로그인 성공');
  return true;
}

// ── CC 로그인 ──
async function loginCC(page: Page, captchaCode: string): Promise<boolean> {
  console.log('  CC 접속...');
  await page.goto(D.cc.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sl(6000);

  // CC login form: input[name="name"], input[name="password"], input[name="captcha"]
  await page.evaluate((d: any) => {
    const nameInput = document.querySelector('input[name="name"]') as HTMLInputElement;
    const passInput = document.querySelector('input[name="password"]') as HTMLInputElement;
    const captchaInput = document.querySelector('input[name="captcha"]') as HTMLInputElement;
    if (nameInput) { nameInput.value = d.user; nameInput.dispatchEvent(new Event('input', { bubbles: true })); }
    if (passInput) { passInput.value = d.pass; passInput.dispatchEvent(new Event('input', { bubbles: true })); }
    if (captchaInput) { captchaInput.value = d.captcha; captchaInput.dispatchEvent(new Event('input', { bubbles: true })); }
  }, { user: D.cc.user, pass: D.cc.pass, captcha: captchaCode });

  await sl(500);

  // Click login button
  await page.evaluate(() => {
    const btn = document.querySelector('button.uedc-ppkg-login_product-submit') as HTMLElement;
    if (btn) { btn.click(); return; }
    const btns = document.querySelectorAll('button');
    for (let i = 0; i < btns.length; i++) {
      if (/log\s*in/i.test(btns[i].textContent || '')) { btns[i].click(); return; }
    }
  });

  await sl(8000);
  const url = page.url();
  console.log(`  URL: ${url}`);
  if (url.includes('login')) { console.log('  ❌ 로그인 실패'); return false; }
  console.log('  ✅ 로그인 성공');
  return true;
}

// ── 메뉴 캡처 ──
async function captureMenu(page: Page, hash: string, name: string, outPath: string) {
  // SPA 해시 라우팅: evaluate로 location.hash 변경
  await page.evaluate((h: string) => { window.location.hash = h; }, hash);
  await sl(10000); // SPA 렌더링 대기
  await page.screenshot({ path: outPath, fullPage: false });
  const kb = Math.round(statSync(outPath).size / 1024);
  console.log(`  ✅ ${name} (${kb}KB)`);
}

async function main() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const ctx = browser.contexts()[0];
  ['epp', 'iag', 'cc'].forEach(d => mkdirSync(join(OUT_DIR, d), { recursive: true }));

  // 인자: EPP captcha, CC captcha
  const eppCaptcha = process.argv[2];
  const ccCaptcha = process.argv[3];

  // ── EPP ──
  console.log('\n=== EPP (10.80.1.106) ===');
  const ep = await ctx.newPage();
  if (!eppCaptcha) {
    // CAPTCHA 스크린샷만 찍고 종료
    await ep.goto(D.epp.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sl(5000);
    await captureCaptcha(ep, '/tmp/epp_login_screen.png');
    console.log('  ⏳ CAPTCHA 코드를 /tmp/epp_login_screen.png에서 읽어주세요');
  } else {
    await ep.goto(D.epp.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sl(5000);
    if (await loginEPP(ep, eppCaptcha)) {
      for (const [h, n, f] of [
        ['#/dashboard', 'Dashboard', 'epp/01_dashboard.png'],
        ['#/policy/antiMalware', 'Anti-Malware', 'epp/02_anti_malware.png'],
        ['#/scan', 'Scan Tasks', 'epp/03_scan_tasks.png'],
        ['#/policy/appControl', 'App Control', 'epp/04_app_control.png'],
        ['#/policy/deviceControl', 'Device Control', 'epp/05_device_control.png'],
        ['#/event', 'Security Events', 'epp/06_security_events.png'],
        ['/#/deployment', 'Agent Deploy', 'epp/07_agent_deploy.png'],
      ]) await captureMenu(ep, h, n, join(OUT_DIR, f));
    }
  }
  await ep.close();

  // ── IAG ──
  console.log('\n=== IAG (10.80.1.108) ===');
  const ip = await ctx.newPage();
  if (await loginIAG(ip)) {
    for (const [h, n, f] of [
      ['activityAudit/dlpPolicy', 'DLP Policies', 'iag/01_dlp_policies.png'],
      ['activityAudit/dlpEvent', 'DLP Events', 'iag/02_dlp_events.png'],
      ['onlineActivities/accessPolicy', 'Access Policy', 'iag/03_access_policy.png'],
      ['authentication/endpointCompliance', 'Endpoint Compliance', 'iag/04_endpoint_compliance.png'],
      ['logs/internetAccess', 'Internet Logs', 'iag/05_internet_logs.png'],
    ]) await captureMenu(ip, h, n, join(OUT_DIR, f));
  }
  await ip.close();

  // ── CC ──
  console.log('\n=== CC (10.80.1.107) ===');
  const cp = await ctx.newPage();
  if (!ccCaptcha) {
    await cp.goto(D.cc.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sl(6000);
    await captureCaptcha(cp, '/tmp/cc_login_screen.png');
    console.log('  ⏳ CAPTCHA 코드를 /tmp/cc_login_screen.png에서 읽어주세요');
  } else {
    await cp.goto(D.cc.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sl(6000);
    if (await loginCC(cp, ccCaptcha)) {
      for (const [h, n, f] of [
        ['dashboard', 'Dashboard', 'cc/01_dashboard.png'],
        ['detection/logs', 'Detection Logs', 'cc/02_detection_logs.png'],
        ['detection/threats', 'Threats', 'cc/03_threats.png'],
        ['response', 'Response', 'cc/04_alerts.png'],
      ]) await captureMenu(cp, h, n, join(OUT_DIR, f));
    }
  }
  await cp.close();

  console.log('\n=== 완료 ===');
  browser.close();
}
main().catch(e => { console.error(e.message); process.exit(1); });
