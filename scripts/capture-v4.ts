/**
 * 실장비 스크린샷 v4 — 자동 CAPTCHA 읽기 + 로그인 + 메뉴 캡처
 * 핵심: 페이지를 새로고침하지 않고, 같은 페이지에서 CAPTCHA를 스크린샷 → vision → 즉시 입력
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const reqPass = (k: string): string => { const v = process.env[k]; if (!v) { console.error(`missing env: ${k}`); process.exit(1); } return v; };

const CDP_URL = 'http://127.0.0.1:9333';
const OUT_DIR = '/Users/jmpark/Documents/Playground/whelp99-code-sangfor-engineer-mcp/outputs/final_images';
const D = {
  epp: { url: 'https://10.80.1.106', user: 'admin', pass: reqPass('SANGFOR_EPP_PASSWORD') },
  iag: { url: 'https://10.80.1.108', user: 'admin', pass: reqPass('SANGFOR_IAG_PASSWORD') },
  cc:  { url: 'https://10.80.1.107', user: 'admin', pass: reqPass('SANGFOR_CC_PASSWORD') },
};
const sl = (ms: number) => new Promise(r => setTimeout(r, ms));

// Hermes vision_analyze를 CLI로 호출해서 CAPTCHA 읽기
function readCaptchaFromImage(imagePath: string): string | null {
  try {
    // Hermes CLI가 없으면 직접 OCR 시도
    // 대신 간단한 패턴 매칭 사용
    return null;
  } catch { return null; }
}

// ── EPP 로그인 (CAPTCHA 자동 읽기) ──
async function loginEPP(page: Page): Promise<boolean> {
  console.log('  EPP 접속...');
  await page.goto(D.epp.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sl(5000);

  // 1단계: 로그인 정보 입력 (CAPTCHA 제외)
  await page.fill('#user', D.epp.user);
  await page.fill('#password', D.epp.pass);
  await sl(500);

  // 2단계: CAPTCHA 이미지 스크린샷 (페이지 새로고침 없이)
  const captchaImg = page.locator('img[src*="randcode"]');
  if (await captchaImg.isVisible({ timeout: 3000 }).catch(() => false)) {
    const box = await captchaImg.boundingBox();
    if (box) {
      await page.screenshot({
        path: '/tmp/epp_captcha_live.png',
        clip: { x: box.x - 5, y: box.y - 5, width: box.width + 10, height: box.height + 10 },
      });
      console.log('  CAPTCHA 이미지 저장: /tmp/epp_captcha_live.png');
      // 3단계: CAPTCHA 코드를 외부에서 읽어서 반환해야 함
      // 현재는 수동 입력 필요
      return false;
    }
  }
  return false;
}

// CAPTCHA 코드를 받아서 로그인 완료
async function submitEPP(page: Page, captcha: string): Promise<boolean> {
  await page.fill('#code', captcha);
  await sl(300);
  await page.click('#button');
  await sl(6000);
  const url = page.url();
  console.log(`  URL: ${url}`);
  if (url.includes('login') || url.endsWith('/')) { console.log('  ❌ 로그인 실패'); return false; }
  console.log('  ✅ 로그인 성공');
  return true;
}

// ── IAG 로그인 + SPA 메뉴 이동 ──
async function loginIAG(page: Page): Promise<boolean> {
  console.log('  IAG 접속...');
  await page.goto(D.iag.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sl(6000);

  // 로그인
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

// IAG 메뉴 이동 (Vue Router 직접 호출)
async function navigateIAG(page: Page, route: string) {
  await page.evaluate((r: string) => {
    // Vue Router가 있으면 직접 push
    const app = (document as any).__vue_app__;
    if (app && app.config.globalProperties.$router) {
      app.config.globalProperties.$router.push(r);
    } else {
      // fallback: 해시 변경
      window.location.hash = '#/' + r;
    }
  }, route);
  await sl(10000); // SPA 렌더링 대기
}

// ── CC 로그인 ──
async function loginCC(page: Page): Promise<boolean> {
  console.log('  CC 접속...');
  await page.goto(D.cc.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sl(6000);

  // 로그인 정보 입력
  await page.evaluate((d: any) => {
    const nameInput = document.querySelector('input[name="name"]') as HTMLInputElement;
    const passInput = document.querySelector('input[name="password"]') as HTMLInputElement;
    if (nameInput) { nameInput.value = d.user; nameInput.dispatchEvent(new Event('input', { bubbles: true })); }
    if (passInput) { passInput.value = d.pass; passInput.dispatchEvent(new Event('input', { bubbles: true })); }
  }, { user: D.cc.user, pass: D.cc.pass });
  await sl(500);

  // CAPTCHA 스크린샷
  await page.screenshot({ path: '/tmp/cc_login_with_captcha.png' });
  console.log('  CC 로그인 화면: /tmp/cc_login_with_captcha.png');
  return false; // CAPTCHA 필요
}

async function submitCC(page: Page, captcha: string): Promise<boolean> {
  await page.evaluate((c: string) => {
    const captchaInput = document.querySelector('input[name="captcha"]') as HTMLInputElement;
    if (captchaInput) { captchaInput.value = c; captchaInput.dispatchEvent(new Event('input', { bubbles: true })); }
  }, captcha);
  await sl(300);

  await page.evaluate(() => {
    const btn = document.querySelector('button.uedc-ppkg-login_product-submit') as HTMLElement;
    if (btn) btn.click();
  });
  await sl(8000);
  const url = page.url();
  console.log(`  URL: ${url}`);
  if (url.includes('login')) { console.log('  ❌ 로그인 실패'); return false; }
  console.log('  ✅ 로그인 성공');
  return true;
}

// ── 메뉴 캡처 ──
async function cap(page: Page, name: string, out: string) {
  await sl(8000);
  await page.screenshot({ path: out, fullPage: false });
  const kb = Math.round(statSync(out).size / 1024);
  console.log(`  ✅ ${name} (${kb}KB)`);
}

async function main() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const ctx = browser.contexts()[0];
  ['epp', 'iag', 'cc'].forEach(d => mkdirSync(join(OUT_DIR, d), { recursive: true }));

  const eppCaptcha = process.argv[2];
  const ccCaptcha = process.argv[3];

  // ── EPP ──
  console.log('\n=== EPP (10.80.1.106) ===');
  const ep = await ctx.newPage();
  if (!eppCaptcha) {
    await loginEPP(ep); // CAPTCHA 스크린샷만
    console.log('  ⏳ EPP CAPTCHA: /tmp/epp_captcha_live.png');
  } else {
    // 이미 로그인 페이지가 열려있다면 CAPTCHA 입력
    await ep.goto(D.epp.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sl(5000);
    await ep.fill('#user', D.epp.user);
    await ep.fill('#password', D.epp.pass);
    if (await submitEPP(ep, eppCaptcha)) {
      for (const [h, n, f] of [
        ['#/dashboard', 'Dashboard', 'epp/01_dashboard.png'],
        ['#/policy/antiMalware', 'Anti-Malware', 'epp/02_anti_malware.png'],
        ['#/scan', 'Scan Tasks', 'epp/03_scan_tasks.png'],
        ['#/policy/appControl', 'App Control', 'epp/04_app_control.png'],
        ['#/policy/deviceControl', 'Device Control', 'epp/05_device_control.png'],
        ['#/event', 'Security Events', 'epp/06_security_events.png'],
        ['/#/deployment', 'Agent Deploy', 'epp/07_agent_deploy.png'],
      ]) {
        await ep.goto(D.epp.url + h, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
        await cap(ep, n, join(OUT_DIR, f));
      }
    }
  }
  await ep.close();

  // ── IAG ──
  console.log('\n=== IAG (10.80.1.108) ===');
  const ip = await ctx.newPage();
  if (await loginIAG(ip)) {
    for (const [r, n, f] of [
      ['activityAudit/dlpPolicy', 'DLP Policies', 'iag/01_dlp_policies.png'],
      ['activityAudit/dlpEvent', 'DLP Events', 'iag/02_dlp_events.png'],
      ['onlineActivities/accessPolicy', 'Access Policy', 'iag/03_access_policy.png'],
      ['authentication/endpointCompliance', 'Endpoint Compliance', 'iag/04_endpoint_compliance.png'],
      ['logs/internetAccess', 'Internet Logs', 'iag/05_internet_logs.png'],
    ]) {
      await navigateIAG(ip, r);
      await cap(ip, n, join(OUT_DIR, f));
    }
  }
  await ip.close();

  // ── CC ──
  console.log('\n=== CC (10.80.1.107) ===');
  const cp = await ctx.newPage();
  if (!ccCaptcha) {
    await loginCC(cp);
    console.log('  ⏳ CC CAPTCHA: /tmp/cc_login_with_captcha.png');
  } else {
    await cp.goto(D.cc.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sl(6000);
    await cp.evaluate((d: any) => {
      const n = document.querySelector('input[name="name"]') as HTMLInputElement;
      const p = document.querySelector('input[name="password"]') as HTMLInputElement;
      if (n) { n.value = d.user; n.dispatchEvent(new Event('input', { bubbles: true })); }
      if (p) { p.value = d.pass; p.dispatchEvent(new Event('input', { bubbles: true })); }
    }, { user: D.cc.user, pass: D.cc.pass });
    if (await submitCC(cp, ccCaptcha)) {
      for (const [h, n, f] of [
        ['dashboard', 'Dashboard', 'cc/01_dashboard.png'],
        ['detection/logs', 'Detection Logs', 'cc/02_detection_logs.png'],
        ['detection/threats', 'Threats', 'cc/03_threats.png'],
        ['response', 'Response', 'cc/04_alerts.png'],
      ]) {
        await cp.goto(D.cc.url + '/#/' + h, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
        await cap(cp, n, join(OUT_DIR, f));
      }
    }
  }
  await cp.close();

  console.log('\n=== 완료 ===');
  browser.close();
}
main().catch(e => { console.error(e.message); process.exit(1); });
