/**
 * 실장비 스크린샷 v5 — goto() 없이 메뉴 클릭으로 내비게이션
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const CDP = 'http://127.0.0.1:9333';
const OUT = '/Users/jmpark/Documents/Playground/whelp99-code-sangfor-engineer-mcp/outputs/final_images';
const sl = (ms: number) => new Promise(r => setTimeout(r, ms));

// 페이지에서 메뉴 클릭
async function clickMenu(page: Page, selectors: string[], label: string): Promise<boolean> {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
        await el.click();
        console.log(`  클릭: ${label} (${sel})`);
        return true;
      }
    } catch {}
  }
  console.log(`  ❌ 메뉴 못찾음: ${label}`);
  return false;
}

async function cap(page: Page, name: string, out: string, wait = 6000) {
  await sl(wait);
  await page.screenshot({ path: out, fullPage: false });
  const kb = Math.round(statSync(out).size / 1024);
  console.log(`  ✅ ${name} (${kb}KB)`);
}

async function main() {
  const browser = await chromium.connectOverCDP(CDP);
  const ctx = browser.contexts()[0];
  ['epp', 'iag', 'cc'].forEach(d => mkdirSync(join(OUT, d), { recursive: true }));

  // ── EPP (10.80.1.106) — 해시 라우팅 사용 ──
  console.log('\n=== EPP (10.80.1.106) ===');
  const ep = ctx.pages().find(p => p.url().includes('10.80.1.106'));
  if (ep) {
    // 해시 라우팅으로 메뉴 이동 (EPP는 해시 기반 SPA)
    for (const [hash, name, file] of [
      ['#index', 'Dashboard', 'epp/01_dashboard.png'],
      ['#policy/antiMalware', 'Anti-Malware', 'epp/02_anti_malware.png'],
      ['#scan', 'Scan Tasks', 'epp/03_scan_tasks.png'],
      ['#policy/appControl', 'App Control', 'epp/04_app_control.png'],
      ['#policy/deviceControl', 'Device Control', 'epp/05_device_control.png'],
      ['#event', 'Security Events', 'epp/06_security_events.png'],
      ['#deployment', 'Agent Deploy', 'epp/07_agent_deploy.png'],
    ]) {
      // JavaScript로 해시 변경 (페이지 리로드 없음)
      await ep.evaluate((h: string) => { window.location.hash = h; }, hash);
      await cap(ep, name, join(OUT, file), 5000);
    }
  } else {
    console.log('  ❌ EPP 탭 없음');
  }

  // ── IAG (10.80.1.108) — 해시 라우팅 사용 ──
  console.log('\n=== IAG (10.80.1.108) ===');
  const iag = ctx.pages().find(p => p.url().includes('10.80.1.108'));
  if (iag) {
    for (const [hash, name, file] of [
      ['#monitor/user_manager', 'DLP Policies', 'iag/01_dlp_policies.png'],
      ['#audit/dlp_event', 'DLP Events', 'iag/02_dlp_events.png'],
      ['#policy/access_policy', 'Access Policy', 'iag/03_access_policy.png'],
      ['#auth/endpoint_check', 'Endpoint Compliance', 'iag/04_endpoint_compliance.png'],
      ['#log/internet_log', 'Internet Logs', 'iag/05_internet_logs.png'],
    ]) {
      await iag.evaluate((h: string) => { window.location.hash = h; }, hash);
      await cap(iag, name, join(OUT, file), 6000);
    }
  } else {
    console.log('  ❌ IAG 탭 없음');
  }

  // ── CC (10.80.1.107) — 메뉴 클릭 방식 ──
  console.log('\n=== CC (10.80.1.107) ===');
  const cc = ctx.pages().find(p => p.url().includes('10.80.1.107'));
  if (cc) {
    // 404 페이지에서 홈으로 이동
    if (cc.url().includes('404') || cc.url().includes('error')) {
      console.log('  CC 홈으로 이동...');
      await cc.goto('https://10.80.1.107/ui/', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
      await sl(5000);
    }

    console.log(`  CC 현재 URL: ${cc.url()}`);

    // CC 메뉴 구조 확인
    const ccMenus = await cc.evaluate(() => {
      const menuItems = document.querySelectorAll('nav a, .menu a, .sidebar a, [class*="menu"] a, [class*="nav"] a');
      return Array.from(menuItems).map(a => ({
        text: a.textContent?.trim().substring(0, 50),
        href: (a as HTMLAnchorElement).href,
        class: a.className.substring(0, 50),
      })).filter(m => m.text);
    });
    console.log('  CC 메뉴:', JSON.stringify(ccMenus.slice(0, 10), null, 2));

    // 메뉴 클릭으로 네비게이션
    const ccTargets: [string, string[], string, string][] = [
      ['Dashboard', ['a:has-text("Home")', 'a:has-text("Dashboard")', '[class*="menu"] a:first-child'], 'Dashboard', 'cc/01_dashboard.png'],
      ['Detection Logs', ['a:has-text("Detection")', 'a:has-text("Logs")', 'a:has-text("Event")'], 'Detection Logs', 'cc/02_detection_logs.png'],
      ['Threats', ['a:has-text("Threat")', 'a:has-text("Alert")', 'a:has-text("Security")'], 'Threats', 'cc/03_threats.png'],
      ['Response', ['a:has-text("Response")', 'a:has-text("SOAR")'], 'Response', 'cc/04_alerts.png'],
    ];

    for (const [label, selectors, name, file] of ccTargets) {
      const clicked = await clickMenu(cc, selectors, label);
      if (clicked) {
        await cap(cc, name, join(OUT, file), 6000);
      } else {
        // 클릭 실패 시 현재 화면 캡처
        await cap(cc, name + ' (현재화면)', join(OUT, file), 3000);
      }
    }
  } else {
    console.log('  ❌ CC 탭 없음');
  }

  console.log('\n=== 완료 ===');
  browser.close();
}
main().catch(e => { console.error(e.message); process.exit(1); });
