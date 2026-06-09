/**
 * EPP 로그인 페이지 분석 — DOM 구조 확인
 */
import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9333');
  const context = browser.contexts()[0];
  const page = await context.newPage();

  console.log('EPP 로그인 페이지 접속...');
  await page.goto('https://10.80.1.106', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise(r => setTimeout(r, 5000));

  // Screenshot
  await page.screenshot({ path: '/tmp/epp_login_page.png' });
  console.log('스크린샷 저장: /tmp/epp_login_page.png');

  // DOM 분석
  const html = await page.content();
  
  // Find all input elements
  const inputs = await page.$$eval('input', (els: any[]) => els.map(e => ({
    type: e.type, name: e.name, placeholder: e.placeholder, id: e.id, className: e.className
  })));
  console.log('\n=== Input 요소 ===');
  inputs.forEach((i: any) => console.log(JSON.stringify(i)));

  // Find all buttons
  const buttons = await page.$$eval('button', (els: any[]) => els.map(e => ({
    text: e.textContent?.trim(), type: e.type, className: e.className, id: e.id
  })));
  console.log('\n=== Button 요소 ===');
  buttons.forEach((b: any) => console.log(JSON.stringify(b)));

  // Find captcha elements
  const captchaImgs = await page.$$eval('img', (els: any[]) => els.map(e => ({
    src: e.src?.substring(0, 100), alt: e.alt, className: e.className, width: e.width, height: e.height
  })));
  console.log('\n=== Img 요소 ===');
  captchaImgs.forEach((i: any) => console.log(JSON.stringify(i)));

  await page.close();
  browser.close();
}

main().catch(e => { console.error(e.message); process.exit(1); });
