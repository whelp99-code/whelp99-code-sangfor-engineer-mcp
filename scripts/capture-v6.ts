/**
 * 실장비 스크린샷 v6 — 메뉴 클릭 방식 (goto 없음)
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const CDP = 'http://127.0.0.1:9333';
const OUT = '/Users/jmpark/Documents/Playground/whelp99-code-sangfor-engineer-mcp/outputs/final_images';
const sl = (ms: number) => new Promise(r => setTimeout(r, ms));

async function cap(page: Page, name: string, out: string, wait = 5000) {
  await sl(wait);
  await page.screenshot({ path: out, fullPage: false });
  const kb = Math.round(statSync(out).size / 1024);
  console.log(`  ✅ ${name} (${kb}KB)`);
}

async function main() {
  const browser = await chromium.connectOverCDP(CDP);
  const ctx = browser.contexts()[0];
  ['epp', 'iag', 'cc'].forEach(d => mkdirSync(join(OUT, d), { recursive: true }));

  // ── EPP (해시 라우팅 — 페이지 리로드 없이 해시만 변경) ──
  console.log('\n=== EPP (10.80.1.106) ===');
  const ep = ctx.pages().find(p => p.url().includes('10.80.1.106'));
  if (ep) {
    for (const [hash, name, file] of [
      ['#index', 'Dashboard', 'epp/01_dashboard.png'],
      ['#policy/antiMalware', 'Anti-Malware', 'epp/02_anti_malware.png'],
      ['#scan', 'Scan Tasks', 'epp/03_scan_tasks.png'],
      ['#policy/appControl', 'App Control', 'epp/04_app_control.png'],
      ['#policy/deviceControl', 'Device Control', 'epp/05_device_control.png'],
      ['#event', 'Security Events', 'epp/06_security_events.png'],
      ['#deployment', 'Agent Deploy', 'epp/07_agent_deploy.png'],
    ]) {
      await ep.evaluate((h: string) => { window.location.hash = h; }, hash);
      await cap(ep, name, join(OUT, file), 5000);
    }
  } else console.log('  ❌ EPP 탭 없음');

  // ── IAG (해시 라우팅) ──
  console.log('\n=== IAG (10.80.1.108) ===');
  const iag = ctx.pages().find(p => p.url().includes('10.80.1.108'));
  if (iag) {
    for (const [hash, name, file] of [
      ['#home', 'Home', 'iag/00_home.png'],
      ['#monitor/user_manager', 'User Manager', 'iag/01_dlp_policies.png'],
      ['#audit/dlp_event', 'DLP Events', 'iag/02_dlp_events.png'],
      ['#policy/access_policy', 'Access Policy', 'iag/03_access_policy.png'],
      ['#auth/endpoint_check', 'Endpoint Compliance', 'iag/04_endpoint_compliance.png'],
      ['#log/internet_log', 'Internet Logs', 'iag/05_internet_logs.png'],
    ]) {
      await iag.evaluate((h: string) => { window.location.hash = h; }, hash);
      await cap(iag, name, join(OUT, file), 6000);
    }
  } else console.log('  ❌ IAG 탭 없음');

  // ── CC (메뉴 클릭 — 해시 라우팅 시도) ──
  console.log('\n=== CC (10.80.1.107) ===');
  const cc = ctx.pages().find(p => p.url().includes('10.80.1.107'));
  if (cc) {
    // CC 메뉴 구조 먼저 확인
    const menuTexts = await cc.evaluate(() => {
      const els = document.querySelectorAll('a, [role=menuitem], nav *, [class*=menu] *, [class*=sidebar] *');
      return Array.from(els).map(e => ({
        tag: e.tagName,
        text: e.textContent?.trim().substring(0, 30),
        href: (e as HTMLAnchorElement).href?.substring(0, 80),
      })).filter(m => m.text && m.text.length > 1).slice(0, 20);
    });
    console.log('  CC 메뉴 구조:');
    menuTexts.forEach((m, i) => console.log(`    ${i}: ${m.text} | ${m.href}`));

    // CC 해시 라우팅 시도
    for (const [hash, name, file] of [
      ['overview', 'Dashboard', 'cc/01_dashboard.png'],
      ['detection/log', 'Detection Logs', 'cc/02_detection_logs.png'],
      ['detection/threat', 'Threats', 'cc/03_threats.png'],
      ['response', 'Response', 'cc/04_alerts.png'],
    ]) {
      await cc.evaluate((h: string) => { window.location.hash = '#/' + h; }, hash);
      await cap(cc, name, join(OUT, file), 6000);
    }
  } else console.log('  ❌ CC 탭 없음');

  console.log('\n=== 완료 ===');
  browser.close();
}
main().catch(e => { console.error(e.message); process.exit(1); });
