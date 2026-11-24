import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
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
    await page.waitForFunction(() => (document.querySelector('#ec-status')?.textContent || '').includes('가이드 적용 파일 생략'));
    const saved = await page.locator('#ec-status').textContent();
    expect(saved).toContain('사례 문서는 유지됨');
    expect(saved).toContain('dry-run 봉투는 준비되지 않았습니다');
    expect(saved).toContain('승인·가이드 준비·실행 통과가 아닙니다');
    expect(saved).not.toContain('저장됨');
    expect(saved).not.toContain('현장 인수');
    expect(await page.locator('#ec-json').textContent()).toContain('applyFileOmitted');

    await page.locator('#ec-btn-review').click();
    await page.waitForFunction(() => {
      const json = document.querySelector('#ec-json')?.textContent || '';
      const status = document.querySelector('#ec-status')?.textContent || '';
      return json.includes('schemaVersion') && !json.includes('applyFileOmitted') && status.includes('가이드 적용 파일 생략');
    });
    const afterReview = await page.locator('#ec-status').textContent();
    expect(afterReview).toContain('dry-run 봉투는 준비되지 않았습니다');
    expect(afterReview).not.toContain('저장됨');

    const downloadPromise = page.waitForEvent('download');
    await page.locator('#ec-btn-export').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.docx$/);
    await page.waitForFunction(() => (document.querySelector('#ec-status')?.textContent || '').includes('Word를 받았습니다'));
    expect(await page.locator('#ec-status').textContent()).toContain('승인=false');
    expect(await page.locator('#ec-status').textContent()).toContain('생성 문서 사례 revision');
    expect(await page.locator('#ec-guide-meta').textContent()).toContain('문서 주장');
    expect(await page.locator('#ec-first-use').textContent()).toContain('처음 쓰는 경우');
    await page.close();
  });

  it('does not treat an unsaved export click as a completed download', async () => {
    const page = await openConsole();
    const downloads: string[] = [];
    page.on('download', (download) => { downloads.push(download.suggestedFilename()); });
    await page.locator('#ec-btn-export').click();
    await page.waitForFunction(() => (document.querySelector('#ec-status')?.textContent || '').includes('내보내기 오류'));
    expect(await page.locator('#ec-status').textContent()).toContain('완료가 아닙니다');
    expect(await page.locator('a[download]').count()).toBe(0);
    expect(downloads).toEqual([]);
    await page.close();
  });

  it('resumes a saved case and distinguishes the stored revision', async () => {
    const page = await openConsole();
    await page.locator('#ec-case-id').fill('case-ui-resume-1');
    await page.locator('#ec-reqs').fill('가용 용량 여유 20% 이상 유지');
    await page.locator('#ec-collections').fill('usable-capacity | 40 | TiB');
    await page.locator('#ec-btn-review').click();
    await page.waitForFunction(() => (document.querySelector('#ec-status')?.textContent || '').includes('검토됨'));
    await page.locator('#ec-btn-save').click();
    await page.waitForFunction(() => (document.querySelector('#ec-status')?.textContent || '').includes('가이드 적용 파일 생략'));
    const revision = await page.locator('#ec-revision').inputValue();
    await page.locator('#ec-resume-id').fill('case-ui-resume-1');
    await page.locator('#ec-btn-resume').click();
    await page.waitForFunction(() => {
      const json = document.querySelector('#ec-json')?.textContent || '';
      const status = document.querySelector('#ec-status')?.textContent || '';
      return json.includes('schemaVersion') && !json.includes('applyFileOmitted') && status.includes('가이드 적용 파일 생략');
    });
    const afterResume = await page.locator('#ec-status').textContent();
    expect(afterResume).toContain('dry-run 봉투는 준비되지 않았습니다');
    expect(afterResume).not.toContain('저장됨');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#nav button[data-panel="engineer-case"]').click();
    await page.locator('#ec-resume-id').fill('case-ui-resume-1');
    await page.locator('#ec-btn-resume').click();
    await page.waitForFunction(() => {
      const meta = document.querySelector('#ec-guide-meta')?.textContent || '';
      const status = document.querySelector('#ec-status')?.textContent || '';
      return meta.includes('저장된 현재 revision') && status.includes('가이드 적용 파일 생략');
    });
    expect(await page.locator('#ec-revision').inputValue()).toBe(revision);
    expect(await page.locator('#ec-guide-meta').textContent()).toContain(revision);
    const afterReload = await page.locator('#ec-status').textContent();
    expect(afterReload).toContain('가이드 적용 파일 생략');
    expect(afterReload).toContain('dry-run 봉투는 준비되지 않았습니다');
    expect(afterReload).not.toContain('저장됨');
    await page.close();
  });
});

describe('G3 provided-analysis and revision integrity — real browser', () => {
  it('saves current edited arithmetic, refuses cross-case export and lossy resume edits, then reloads export revision', async () => {
    const page = await openConsole();
    const caseId = 'case-ui-g3-provided';
    const analysis = (revision: string) => JSON.stringify({ caseRevision: revision, calculations: [{ id: 'free', formulaId: 'confirmed-remaining-capacity', roles: { total: 'limit', used: 'consumed' }, outputUnit: 'GiB' }], bindings: [{ requirementId: 'req-1-remaining-20-gib', calculationRef: 'free', fieldId: 'storage_usable_capacity' }] });
    await page.locator('#ec-case-id').fill(caseId);
    await page.locator('#ec-revision').fill('rev-g3-1');
    await page.locator('#ec-reqs').fill('remaining >= 20 GiB');
    await page.locator('#ec-collections').fill('one | 160 | GiB | limit\ntwo | 72 | GiB | consumed');
    await page.locator('#ec-analysis').fill(analysis('rev-g3-1'));
    await page.locator('#ec-btn-review').click();
    await page.waitForFunction(() => (document.querySelector('#ec-calculations')?.textContent || '').includes('88 GiB'));
    // A real click must re-review edits before save; no cached 88 survives.
    await page.locator('#ec-collections').fill('one | 160 | GiB | limit\ntwo | 90 | GiB | consumed');
    const save1 = page.waitForResponse(r => r.url().endsWith('/api/engineer-cases') && r.request().method() === 'POST');
    await page.locator('#ec-btn-save').click(); expect((await save1).status()).toBe(200);
    await page.waitForFunction(() => (document.querySelector('#ec-status')?.textContent || '').includes('사례 문서는 유지됨'));
    const load = async () => { const response = await page.request.post(baseUrl + '/api/engineer-cases/review', { data: { caseId } }); expect(response.status()).toBe(200); return (await response.json()).document; };
    expect((await load()).calculations[0].result.data.number).toBe(160 - 90);
    const firstRevision = await page.locator('#ec-revision').inputValue();
    await page.locator('#ec-collections').fill('one | 160 | GiB | limit\ntwo | 100 | GiB | consumed');
    const editedRevision = await page.locator('#ec-revision').inputValue(); expect(editedRevision).not.toBe(firstRevision);
    await page.locator('#ec-analysis').fill(analysis(editedRevision));
    const save2 = page.waitForResponse(r => r.url().endsWith('/api/engineer-cases') && r.request().method() === 'POST');
    await page.locator('#ec-btn-save').click(); const saved2 = await save2; expect(saved2.status()).toBe(200);
    expect(saved2.request().postDataJSON().expectedRevision).toBe(firstRevision);
    await page.waitForFunction(() => (document.querySelector('#ec-status')?.textContent || '').includes('사례 문서는 유지됨'));
    expect((await load()).calculations[0].result.data.number).toBe(160 - 100);
    await page.locator('#ec-case-id').fill('case-ui-g3-other');
    await page.locator('#ec-btn-review').click();
    await page.waitForFunction(() => (document.querySelector('#ec-status')?.textContent || '').includes('검토됨'));
    await page.locator('#ec-btn-export').click();
    expect(await page.locator('#ec-status').textContent()).toContain('내보내기 오류');
    await page.locator('#ec-resume-id').fill(caseId);
    await page.locator('#ec-btn-resume').click();
    await page.waitForFunction(() => (document.querySelector('#ec-guide-meta')?.textContent || '').includes('저장된 현재 revision'));
    await page.locator('#ec-collections').fill('one | 160 | GiB | limit\ntwo | 1 | GiB | consumed');
    await page.locator('#ec-btn-save').click();
    expect(await page.locator('#ec-status').textContent()).toContain('새 사례 ID');
    expect((await load()).calculations[0].result.data.number).toBe(60);
    await page.locator('#ec-btn-resume').click();
    await page.waitForFunction(() => (document.querySelector('#ec-status')?.textContent || '').includes('가이드 적용 파일 생략'));
    const download = page.waitForEvent('download'); await page.locator('#ec-btn-export').click();
    expect((await download).suggestedFilename()).toMatch(/\.docx$/);
    await page.waitForFunction(() => (document.querySelector('#ec-status')?.textContent || '').includes('Word를 받았습니다'));
    await page.locator('#ec-btn-save').click(); expect(await page.locator('#ec-status').textContent()).toContain('불러오기');
    await page.locator('#ec-btn-resume').click();
    await page.waitForFunction(() => (document.querySelector('#ec-guide-meta')?.textContent || '').includes('저장된 현재 revision'));
    const current = await load(); expect(current.revision).not.toBe(editedRevision); expect(current.calculations[0].result.data.number).toBe(60);
    await page.close();
  }, 30_000);
});

describe('single reviewer repair — real browser and HTTP persistence', () => {
  it('resume A → new B save → B edit persists new revision and Word without changing rich A', async () => {
    const page = await openConsole();
    const phase = process.env.G3_REPAIR_PHASE || 'local';
    const root = process.env.G3_REPAIR_EVIDENCE_DIR || mkdtempSync(join(tmpdir(), 'g3-repair-'));
    const artifacts = join(root, 'browser-' + phase); mkdirSync(artifacts, { recursive: true });
    const trace: Record<string, any> = { phase, fixture: true, live: false, fieldAccepted: false };
    const aid = 'case-repair-rich-a', bid = 'case-repair-editable-b';
    const analysis = (revision: string) => JSON.stringify({ caseRevision: revision, calculations: [{ id: 'free', formulaId: 'confirmed-remaining-capacity', roles: { total: 'limit', used: 'consumed' }, outputUnit: 'GiB' }], bindings: [{ requirementId: 'req-1-remaining-20-gib', calculationRef: 'free', fieldId: 'storage_usable_capacity' }] });
    const post = async (path: string, data: unknown) => { const response = await page.request.post(baseUrl + '/api/engineer-cases' + path, { data }); expect(response.status()).toBe(200); return response.json(); };
    const load = async (caseId: string) => (await post('/review', { caseId })).document;
    const uiSave = async () => {
      const response = page.waitForResponse(r => r.url().endsWith('/api/engineer-cases') && r.request().method() === 'POST');
      await page.locator('#ec-btn-save').click(); const r = await response;
      const result = { request: r.request().postDataJSON(), status: r.status(), body: await r.json() };
      await page.waitForFunction(() => !(document.querySelector('#ec-status')?.textContent || '').includes('입력이 바뀌었습니다'));
      return result;
    };
    try {
      // Rich A and editable B are provided-only fixtures using the real service/store.
      const reviewedA = await post('/review', { draft: { caseId: aid, revision: 'rev-rich-a', mode: 'existing', product: 'HCI_SCP', requirementLines: ['remaining >= 20 GiB'], collections: [{ id: 'limit', label: 'one', valueText: '160', unit: 'GiB' }, { id: 'consumed', label: 'two', valueText: '72', unit: 'GiB' }], analysis: JSON.parse(analysis('rev-rich-a')) } });
      await post('', { requestId: 'seed-rich-a', document: reviewedA.document });
      trace.originalA = await load(aid); expect(trace.originalA.calculations[0].result.data.number).toBe(160 - 72);
      await page.locator('#ec-resume-id').fill(aid);
      const resumeA = page.waitForResponse(r => r.url().endsWith('/api/engineer-cases/review'));
      await page.locator('#ec-btn-resume').click(); expect((await resumeA).status()).toBe(200);
      await page.waitForFunction(() => (document.querySelector('#ec-json')?.textContent || '').includes('rev-rich-a'));
      let saves = 0; const countSaves = (request: import('playwright').Request) => { if (request.url().endsWith('/api/engineer-cases') && request.method() === 'POST') saves++; }; page.on('request', countSaves);
      await page.locator('#ec-collections').fill('one | 1 | GiB | limit');
      await page.locator('#ec-btn-save').click(); expect(await page.locator('#ec-status').textContent()).toContain('새 사례 ID'); expect(saves).toBe(0);
      await page.locator('#ec-case-id').fill(bid); await page.locator('#ec-revision').fill('rev-editable-b');
      await page.locator('#ec-collections').fill('one | 160 | GiB | limit\ntwo | 72 | GiB | consumed');
      await page.locator('#ec-analysis').fill(analysis('rev-editable-b'));
      trace.firstB = await uiSave(); expect(trace.firstB.status).toBe(200); expect(trace.firstB.request.expectedRevision).toBeUndefined();
      const oldRevision = trace.firstB.body.revision;
      await page.locator('#ec-collections').fill('one | 160 | GiB | limit\ntwo | 100 | GiB | consumed');
      const editedRevision = await page.locator('#ec-revision').inputValue(); trace.oldRevision = oldRevision; trace.editedRevision = editedRevision;
      await page.locator('#ec-analysis').fill(analysis(editedRevision));
      // Reach actual persistence before asserting, to record the pre-fix 409.
      trace.editedB = await uiSave(); trace.loadedB = await load(bid);
      expect(trace.editedB.request.expectedRevision).toBe(oldRevision);
      expect(trace.editedB.status).toBe(200); expect(trace.editedB.body.status).toBe('saved');
      expect(editedRevision).not.toBe(oldRevision); expect(trace.editedB.request.document.revision).toBe(editedRevision);
      expect(trace.loadedB.revision).toBe(editedRevision); expect(trace.loadedB.calculations[0].result.data.number).toBe(160 - 100);
      expect(trace.loadedB.observations.every((o: any) => o.sourceKind === 'provided')).toBe(true);
      expect(trace.loadedB).toMatchObject({ synthetic: true, originalPresent: false, environmentKind: 'fixture', execution: { result: 'not_started' } });
      expect(trace.editedB.body).toMatchObject({ approved: false, guideReadyGranted: false, executionPassGranted: false });
      await page.locator('#ec-case-id').fill(aid); const count = saves;
      await page.locator('#ec-btn-save').click(); await page.locator('#ec-btn-review').click();
      expect(saves).toBe(count); expect(await page.locator('#ec-status').textContent()).toContain('새 사례 ID');
      trace.afterA = await load(aid); expect(trace.afterA).toEqual(trace.originalA);
      await page.locator('#ec-resume-id').fill(bid);
      const resumeB = page.waitForResponse(r => r.url().endsWith('/api/engineer-cases/review'));
      await page.locator('#ec-btn-resume').click(); expect((await resumeB).status()).toBe(200);
      await page.waitForFunction(() => (document.querySelector('#ec-case-id') as HTMLInputElement)?.value === 'case-repair-editable-b');
      expect(await page.locator('#ec-revision').inputValue()).toBe(editedRevision);
      expect(await page.locator('#ec-calculations').textContent()).toContain('60 GiB');
      const exported = page.waitForResponse(r => r.url().endsWith('/api/engineer-cases/guide-export'));
      const downloading = page.waitForEvent('download'); await page.locator('#ec-btn-export').click();
      const exportResponse = await exported; trace.export = { request: exportResponse.request().postDataJSON(), status: exportResponse.status(), body: await exportResponse.json() };
      const download = await downloading; const binary = join(artifacts, 'editable-b.docx'); await download.saveAs(binary);
      const xml = execFileSync('unzip', ['-p', binary, 'word/document.xml'], { encoding: 'utf8' }); writeFileSync(join(artifacts, 'editable-b.document.xml'), xml);
      expect(trace.export.status).toBe(200); expect(trace.export.request).toEqual({ caseId: bid, expectedRevision: editedRevision });
      expect(trace.export.body.exportedCaseRevision).toBe(editedRevision);
      for (const text of [bid, editedRevision, '60', 'GiB', 'free', 'confirmed-remaining-capacity', 'provided']) expect(xml).toContain(text);
      expect(xml).not.toContain(aid); trace.afterExportB = await load(bid);
      expect(trace.afterExportB.revision).toBe(trace.export.body.currentCaseRevision); expect(trace.afterExportB.revision).not.toBe(editedRevision);
      expect(trace.afterExportB.calculations[0].result.data.number).toBe(160 - 100);
      await page.waitForFunction(() => (document.querySelector('#ec-status')?.textContent || '').includes('Word를 받았습니다'));
      await page.screenshot({ path: join(artifacts, 'word-export.png'), fullPage: true });
      trace.result = 'assertions-completed';
    } finally { writeFileSync(join(artifacts, 'trace.json'), JSON.stringify(trace, null, 2)); await page.close(); }
  }, 30_000);
});
