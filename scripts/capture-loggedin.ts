/**
 * 실장비 스크린샷 — 이미 로그인된 상태에서 메뉴별 캡처
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const CDP_URL = 'http://127.0.0.1:9333';
const OUT = '/Users/jmpark/Documents/Playground/whelp99-code-sangfor-engineer-mcp/outputs/final_images';
const sl = (ms: number) => new Promise(r => setTimeout(r, ms));

async function findPage(context: any, urlPattern: string): Promise<Page | null> {
  for (const p of context.pages()) {
    if (p.url().includes(urlPattern)) return p;
  }
  return null;
}

async function cap(page: Page, name: string, outPath: string, waitMs = 6000) {
  await sl(waitMs);
  await page.screenshot({ path: outPath, fullPage: false });
  const kb = Math.round(statSync(outPath).size / 1024);
  console.log(`  ✅ ${name} (${kb}KB)`);
}

async function main() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const ctx = browser.contexts()[0];
  mkdirSync(join(OUT, 'epp'), { recursive: true });
  mkdirSync(join(OUT, 'iag'), { recursive: true });
  mkdirSync(join(OUT, 'cc'), { recursive: true });

  // ── EPP (이미 로그인됨: 10.80.1.106) ──
  console.log('\n=== EPP (10.80.1.106) ===');
  const ep = await findPage(ctx, '10.80.1.106');
  if (ep) {
    for (const [path, name, file] of [
      ['/#/index', 'Dashboard', 'epp/01_dashboard.png'],
      ['/#/policy/antiMalware', 'Anti-Malware', 'epp/02_anti_malware.png'],
      ['/#/scan', 'Scan Tasks', 'epp/03_scan_tasks.png'],
      ['/#/policy/appControl', 'App Control', 'epp/04_app_control.png'],
      ['/#/policy/deviceControl', 'Device Control', 'epp/05_device_control.png'],
      ['/#/event', 'Security Events', 'epp/06_security_events.png'],
      ['/#/deployment', 'Agent Deploy', 'epp/07_agent_deploy.png'],
    ]) {
      await ep.goto(`https://10.80.1.106${path}`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
      await cap(ep, name, join(OUT, file), 5000);
    }
  } else {
    console.log('  ❌ EPP 탭을 찾을 수 없습니다');
  }

  // ── CC (이미 로그인됨: 10.80.1.107) ──
  console.log('\n=== CC (10.80.1.107) ===');
  const cc = await findPage(ctx, '10.80.1.107');
  if (cc) {
    for (const [path, name, file] of [
      ['/#/overview', 'Dashboard', 'cc/01_dashboard.png'],
      ['/#/detection/logs', 'Detection Logs', 'cc/02_detection_logs.png'],
      ['/#/detection/threats', 'Threats', 'cc/03_threats.png'],
      ['/#/response', 'Response', 'cc/04_alerts.png'],
    ]) {
      await cc.goto(`https://10.80.1.107${path}`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
      await cap(cc, name, join(OUT, file), 5000);
    }
  } else {
    console.log('  ❌ CC 탭을 찾을 수 없습니다');
  }

  // ── IAG (10.80.1.108) — 로그인 필요할 수 있음 ──
  console.log('\n=== IAG (10.80.1.108) ===');
  const iag = await findPage(ctx, '10.80.1.108');
  if (iag) {
    // IAG가 로그인 페이지에 있으면 로그인 시도
    if (iag.url().includes('login')) {
      console.log('  IAG 로그인 시도...');
      await iag.evaluate((d: any) => {
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
      }, { user: 'admin', pass: 'Itac123#@!' });
      await sl(8000);
      console.log(`  URL: ${iag.url()}`);
    }

    // IAG 메뉴 캡처
    for (const [path, name, file] of [
      ['/#/activityAudit/dlpPolicy', 'DLP Policies', 'iag/01_dlp_policies.png'],
      ['/#/activityAudit/dlpEvent', 'DLP Events', 'iag/02_dlp_events.png'],
      ['/#/onlineActivities/accessPolicy', 'Access Policy', 'iag/03_access_policy.png'],
      ['/#/authentication/endpointCompliance', 'Endpoint Compliance', 'iag/04_endpoint_compliance.png'],
      ['/#/logs/internetAccess', 'Internet Logs', 'iag/05_internet_logs.png'],
    ]) {
      await iag.goto(`https://10.80.1.108${path}`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
      await cap(iag, name, join(OUT, file), 6000);
    }
  } else {
    console.log('  ❌ IAG 탭을 찾을 수 없습니다');
  }

  console.log('\n=== 완료 ===');
  browser.close();
}
main().catch(e => { console.error(e.message); process.exit(1); });
