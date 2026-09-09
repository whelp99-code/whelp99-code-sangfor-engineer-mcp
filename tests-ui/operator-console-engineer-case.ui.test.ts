import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Browser, Page } from 'playwright';
import { chromium } from 'playwright';
import { BlroAuthorityStore } from '../packages/sangfor-authority/src/authority-store.js';
import {
  ENGINEER_CASE_READ_PERMISSION,
  ENGINEER_CASE_WRITE_PERMISSION,
} from '../packages/sangfor-authority/src/authority-store-contracts.js';
import { createOperatorServer } from '../apps/operator-console/src/server.js';
import { FakeEngineerCaseAuthorityDatabase } from '../tests/helpers/engineer-case-authority-db.js';

const AUTH = { tenantId: 'tenant-a', projectId: 'proj-a', actorId: 'actor-a' } as const;

let browser: Browser;
let server: ReturnType<typeof createOperatorServer>;
let baseUrl: string;

async function openConsole(): Promise<Page> {
  const page = await browser.newPage();
  await page.addInitScript(() => { (window as unknown as { __untrustedExecuted?: boolean }).__untrustedExecuted = false; });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#nav button[data-panel="engineer-case"]').click();
  return page;
}

beforeAll(async () => {
  const db = new FakeEngineerCaseAuthorityDatabase();
  db.grant(AUTH, [ENGINEER_CASE_READ_PERMISSION, ENGINEER_CASE_WRITE_PERMISSION]);
  const store = new BlroAuthorityStore(db);
  server = createOperatorServer({
    engineerCase: {
      store: {
        save: (input) => store.saveEngineerCase(input),
        load: (input) => store.loadEngineerCase(input),
        loadArtifact: (input) => store.loadEngineerCaseArtifact(input),
      },
      auth: AUTH,
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

describe('operator console engineer case review — real browser', () => {
  it('reviews provided and unknown inputs without treating the result as complete', async () => {
    const page = await openConsole();
    await page.locator('#ec-case-id').fill('case-ui-1');
    await page.locator('#ec-reqs').fill('가용 용량 여유 20% 이상 유지\n<img src=x onerror="window.__untrustedExecuted=true">');
    await page.locator('#ec-collections').fill('usable-capacity | 40 | TiB\nhost-cpu | | cores');
    await page.locator('#ec-btn-review').click();
    await page.waitForFunction(() => (document.querySelector('#ec-status')?.textContent || '').includes('검토됨'));

    const status = await page.locator('#ec-status').textContent();
    expect(status).toContain('완료가 아닙니다');
    expect(status).toContain('승인=false');
    expect(status).toContain('가이드준비부여=false');
    expect(status).toContain('실행통과부여=false');
    expect(status).toContain('계산 불가');
    expect(status).toContain('장비 수집이 연결되어 있지 않습니다');
    expect(await page.locator('#ec-observations').textContent()).toContain('제공값');
    expect(await page.locator('#ec-observations').textContent()).toContain('미확인');
    expect(await page.locator('#ec-requirements').textContent()).toContain('가용 용량 여유 20% 이상 유지');
    expect(await page.locator('#ec-requirements img').count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __untrustedExecuted?: boolean }).__untrustedExecuted)).toBe(false);

    await page.locator('#ec-btn-save').click();
    await page.waitForFunction(() => (document.querySelector('#ec-status')?.textContent || '').includes('저장됨'));
    const saved = await page.locator('#ec-status').textContent();
    expect(saved).toContain('승인·가이드 준비·실행 통과가 아닙니다');
    expect(saved).not.toContain('현장 인수');

    await page.locator('#ec-btn-export').click();
    expect(await page.locator('#ec-status').textContent()).toContain('내보내기 오류');
    expect(await page.locator('#ec-status').textContent()).toContain('완료가 아닙니다');
    expect(await page.locator('a[download]').count()).toBe(0);
    await page.close();
  });
});
