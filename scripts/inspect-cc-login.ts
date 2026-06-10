/**
 * CC 로그인 페이지 확인 (CC 쿠키만 삭제)
 */
import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
  const context = browser.contexts()[0];

  // CC 관련 쿠키만 삭제
  console.log('CC 쿠키만 삭제...');
  const allCookies = await context.cookies();
  const ccCookies = allCookies.filter(c => c.domain.includes('10.80.1.107'));
  console.log(`  CC 쿠키 ${ccCookies.length}개 삭제`);
  for (const c of ccCookies) {
    await context.clearCookies({ name: c.name });
  }

  // 새 탭으로 CC 로그인 페이지 열기
  const page = await context.newPage();
  console.log('CC 로그인 페이지 접속...');
  await page.goto('https://10.80.1.107', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise(r => setTimeout(r, 10000));

  console.log(`URL: ${page.url()}`);
  console.log(`제목: ${await page.title()}`);

  await page.screenshot({ path: '/tmp/cc_login_fresh.png', fullPage: true });
  console.log('스크린샷: /tmp/cc_login_fresh.png');

  // Input elements
  const inputs = await page.$$eval('input', (els: any[]) => els.map(e => ({
    type: e.type, name: e.name, placeholder: e.placeholder, id: e.id
  })));
  console.log('\n=== Input 요소 ===');
  inputs.forEach((i: any) => console.log(JSON.stringify(i)));

  // Images
  const imgs = await page.$$eval('img', (els: any[]) => els.map(e => ({
    src: e.src?.substring(0, 150), alt: e.alt
  })));
  console.log('\n=== Img 요소 ===');
  imgs.forEach((i: any) => console.log(JSON.stringify(i)));

  // Buttons
  const buttons = await page.$$eval('button, input[type="button"], input[type="submit"]', (els: any[]) => els.map(e => ({
    tag: e.tagName, text: e.textContent?.trim()?.substring(0, 50), type: e.type, id: e.id
  })));
  console.log('\n=== Button 요소 ===');
  buttons.forEach((b: any) => console.log(JSON.stringify(b)));
}

main().catch(e => { console.error(e.message); process.exit(1); });
