/**
 * 실장비 스크린샷 — v2 (로그인 + SPA 렌더링 대기)
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const reqPass = (k: string): string => { const v = process.env[k]; if (!v) { console.error(`missing env: ${k}`); process.exit(1); } return v; };

const CDP_URL = 'http://127.0.0.1:9333';
const OUT_DIR = '/Users/jmpark/Documents/Playground/whelp99-code-sangfor-engineer-mcp/outputs/final_images';
const D = {
  epp: { url: 'https://10.80.1.106', user: 'admin', pass: reqPass('SANGFOR_EPP_PASSWORD') },
  iag: { url: 'https://10.80.1.108', user: 'admin', pass: reqPass('SANGFOR_IAG_PASSWORD') },
  cc:  { url: 'https://10.80.1.107', user: 'admin', pass: reqPass('SANGFOR_CC_PASSWORD') },
};
const sl = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── EPP ──
async function loginEPP(p: Page, captcha?: string): Promise<boolean> {
  console.log('  EPP 접속...');
  await p.goto(D.epp.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sl(5000);
  await p.fill('#user', D.epp.user);
  await sl(300);
  await p.fill('#password', D.epp.pass);
  await sl(300);
  if (captcha) {
    await p.fill('#code', captcha);
    await sl(300);
  }
  // CAPTCHA 스크린샷
  const ci = p.locator('img[src*="randcode"]');
  if (await ci.isVisible({ timeout: 2000 }).catch(() => false)) {
    const b = await ci.boundingBox();
    if (b) await p.screenshot({ path: '/tmp/epp_captcha_crop.png', clip: { x: b.x-5, y: b.y-5, width: b.width+10, height: b.height+10 } });
  }
  if (!captcha) { console.log('  ⏳ CAPTCHA 필요'); return false; }
  await p.click('#button');
  await sl(5000);
  console.log(`  URL: ${p.url()}`);
  return !p.url().includes('login');
}

// ── IAG ──
async function loginIAG(p: Page): Promise<boolean> {
  console.log('  IAG 접속...');
  await p.goto(D.iag.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sl(6000);
  await p.evaluate((d) => {
    const els = document.querySelectorAll('input');
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      if (el.type === 'text' || el.name === 'username') { el.value = d.user; el.dispatchEvent(new Event('input', {bubbles:true})); }
      if (el.type === 'password') { el.value = d.pass; el.dispatchEvent(new Event('input', {bubbles:true})); }
    }
    const btns = document.querySelectorAll('input[type="button"], button');
    for (let i = 0; i < btns.length; i++) {
      const t = btns[i].textContent || (btns[i] as any).value || '';
      if (/login|로그인/i.test(t)) { (btns[i] as HTMLElement).click(); return; }
    }
    if (btns[0]) (btns[0] as HTMLElement).click();
  }, { user: D.iag.user, pass: D.iag.pass });
  await sl(8000);
  console.log(`  URL: ${p.url()}`);
  return !p.url().includes('login');
}

// ── CC ──
async function loginCC(p: Page): Promise<boolean> {
  console.log('  CC 접속...');
  await p.goto(D.cc.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sl(6000);
  await p.evaluate((d) => {
    const els = document.querySelectorAll('input');
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      if (el.type === 'text' || el.name === 'username') { el.value = d.user; el.dispatchEvent(new Event('input', {bubbles:true})); }
      if (el.type === 'password') { el.value = d.pass; el.dispatchEvent(new Event('input', {bubbles:true})); }
    }
    const btns = document.querySelectorAll('input[type="button"], button, a.btn');
    for (let i = 0; i < btns.length; i++) {
      const t = btns[i].textContent || (btns[i] as any).value || '';
      if (/login|로그인/i.test(t)) { (btns[i] as HTMLElement).click(); return; }
    }
    if (btns[0]) (btns[0] as HTMLElement).click();
  }, { user: D.cc.user, pass: D.cc.pass });
  await sl(8000);
  console.log(`  URL: ${p.url()}`);
  return !p.url().includes('login');
}

async function cap(p: Page, name: string, out: string) {
  await sl(8000);
  await p.screenshot({ path: out, fullPage: false });
  console.log(`  ✅ ${name} (${Math.round(statSync(out).size/1024)}KB)`);
}

async function main() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const ctx = browser.contexts()[0];
  ['epp','iag','cc'].forEach(d => mkdirSync(join(OUT_DIR, d), { recursive: true }));

  const captchaArg = process.argv[2];

  // EPP
  console.log('\n=== EPP ===');
  const ep = await ctx.newPage();
  if (await loginEPP(ep, captchaArg)) {
    for (const m of [
      ['/#/dashboard','Dashboard','epp/01_dashboard.png'],
      ['/#/policy/antiMalware','Anti-Malware','epp/02_anti_malware.png'],
      ['/#/scan','Scan Tasks','epp/03_scan_tasks.png'],
      ['/#/policy/appControl','App Control','epp/04_app_control.png'],
      ['/#/policy/deviceControl','Device Control','epp/05_device_control.png'],
      ['/#/event','Security Events','epp/06_security_events.png'],
      ['/#/deployment','Agent Deploy','epp/07_agent_deploy.png'],
    ]) {
      await ep.goto(D.epp.url + m[0], { waitUntil: 'networkidle', timeout: 30000 }).catch(()=>{});
      await cap(ep, m[1], join(OUT_DIR, m[2]));
    }
  }
  await ep.close();

  // IAG
  console.log('\n=== IAG ===');
  const ip = await ctx.newPage();
  if (await loginIAG(ip)) {
    for (const m of [
      ['/#/activityAudit/dlpPolicy','DLP Policies','iag/01_dlp_policies.png'],
      ['/#/activityAudit/dlpEvent','DLP Events','iag/02_dlp_events.png'],
      ['/#/onlineActivities/accessPolicy','Access Policy','iag/03_access_policy.png'],
      ['/#/authentication/endpointCompliance','Endpoint Compliance','iag/04_endpoint_compliance.png'],
      ['/#/logs/internetAccess','Internet Logs','iag/05_internet_logs.png'],
    ]) {
      await ip.goto(D.iag.url + m[0], { waitUntil: 'networkidle', timeout: 30000 }).catch(()=>{});
      await cap(ip, m[1], join(OUT_DIR, m[2]));
    }
  } else { console.log('  ❌ IAG 로그인 실패'); }
  await ip.close();

  // CC
  console.log('\n=== CC ===');
  const cp = await ctx.newPage();
  if (await loginCC(cp)) {
    for (const m of [
      ['/#/dashboard','Dashboard','cc/01_dashboard.png'],
      ['/#/detection/logs','Detection Logs','cc/02_detection_logs.png'],
      ['/#/detection/threats','Threats','cc/03_threats.png'],
      ['/#/response','Response','cc/04_alerts.png'],
    ]) {
      await cp.goto(D.cc.url + m[0], { waitUntil: 'networkidle', timeout: 30000 }).catch(()=>{});
      await cap(cp, m[1], join(OUT_DIR, m[2]));
    }
  } else { console.log('  ❌ CC 로그인 실패'); }
  await cp.close();

  console.log('\n=== 완료 ===');
  browser.close();
}
main().catch(e => { console.error(e.message); process.exit(1); });
