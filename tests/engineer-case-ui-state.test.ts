import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { ENGINEER_CASE_ACTION_SCRIPT } from '../apps/operator-console/src/ui-engineer-case-actions.js';

// Execute the shipped generated script, not a duplicate state-machine implementation.
class Element {
  value = ''; textContent = ''; className = ''; children: Element[] = [];
  onclick?: () => Promise<void> | void;
  listeners: Record<string, (() => void)[]> = {};
  get firstChild() { return this.children[0]; }
  appendChild(e: Element) { this.children.push(e); }
  removeChild(e: Element) { this.children.splice(this.children.indexOf(e), 1); }
  addEventListener(name: string, fn: () => void) { (this.listeners[name] ??= []).push(fn); }
  dispatch(name: string) { this.listeners[name]?.forEach(fn => fn()); }
  click() { return this.onclick?.(); }
  remove() {}
}
function harness() {
  const elements: Record<string, Element> = {};
  const $ = (id: string) => elements[id] ??= new Element();
  $('ec-mode').value = 'existing'; $('ec-product').value = 'HCI_SCP';
  $('ec-case-id').value = 'case-a'; $('ec-revision').value = 'rev-1';
  $('ec-reqs').value = 'remaining >= 20 GiB'; $('ec-collections').value = 'disk | 50 | GiB';
  const calls: { path: string; body: any }[] = [];
  const pending: ((data: any) => void)[] = [];
  runInNewContext(ENGINEER_CASE_ACTION_SCRIPT, { $, document: { createElement: () => new Element(), body: new Element() },
    lines: (id: string) => $(id).value.split('\n').filter(Boolean),
    sessionStorage: { getItem: () => null, setItem: () => {} },
    buildApiHeaders: (_: unknown, headers: unknown) => headers, readApiToken: () => '',
    URL: { createObjectURL: () => 'blob:fixture', revokeObjectURL: () => {} },
    fetch: (path: string, req: any) => {
      calls.push({ path, body: req.body ? JSON.parse(req.body) : null });
      return new Promise(resolve => pending.push(data => resolve({ status: 200, ok: true, json: async () => data,
        blob: async () => ({}), headers: { get: () => '' } })));
    },
  });
  const answerAt = async (index: number, data: any) => { const fn = pending.splice(index, 1)[0]; expect(fn).toBeTypeOf('function'); fn!(data); await flush(); };
  const answer = (data: any) => answerAt(0, data);
  const edit = (id: string, value: string) => { $(id).value = value; $(id).dispatch('input'); $(id).dispatch('change'); };
  return { $, calls, answer, answerAt, edit };
}
async function flush() { for (let i = 0; i < 15; i++) await Promise.resolve(); }
function reviewed(caseId = 'case-a', revision = 'rev-1', durable = 'unsaved') {
  return { ok: true, status: 'reviewed', durable, review: { caseId, revision, guide: {} },
    document: { caseId, revision, mode: 'existing', product: 'HCI_SCP', requirements: [{ constraint: 'remaining >= 20 GiB' }],
      observations: [{ id: 'custom-disk', target: 'disk', value: { presence: 'known', data: { kind: 'number', number: 50, unit: 'GiB' } } }],
      calculations: [{ id: 'calc-preserved' }], guide: {} } };
}
const saved = { ok: true, status: 'saved', caseId: 'case-a', revision: 'rev-1' };
describe('generated engineer UI async revision invariants', () => {
  it('review → edit → save re-reviews current form, not the cached document', async () => {
    const h = harness(); const r = h.$('ec-btn-review').click(); await h.answer(reviewed()); await r;
    h.edit('ec-collections', 'disk | 70 | GiB');
    const s = h.$('ec-btn-save').click(); await flush();
    expect(h.calls.at(-1)?.path).toBe('/api/engineer-cases/review');
    expect(h.calls.at(-1)?.body.draft.collections[0].valueText).toBe('70');
    await h.answer(reviewed()); await h.answer(saved); await s;
  });
  it('A save → B review cannot export A or unsaved B', async () => {
    const h = harness(); const s = h.$('ec-btn-save').click(); await h.answer(reviewed()); await h.answer(saved); await s;
    h.edit('ec-case-id', 'case-b'); const r = h.$('ec-btn-review').click(); await h.answer(reviewed('case-b')); await r;
    const count = h.calls.length; await h.$('ec-btn-export').click();
    expect(h.calls).toHaveLength(count);
    const b = h.$('ec-btn-save').click(); await flush();
    expect(h.calls.at(-1)?.body.expectedRevision).toBeUndefined();
    await h.answer({ ...saved, caseId: 'case-b' }); await b;
  });
  it('out-of-order reviews and save responses cannot overwrite current edits', async () => {
    const h = harness(); const a = h.$('ec-btn-review').click();
    h.edit('ec-case-id', 'case-b'); const b = h.$('ec-btn-review').click();
    await h.answerAt(1, reviewed('case-b')); await b;
    await h.answer(reviewed('case-a')); await a; expect(h.$('ec-case-id').value).toBe('case-b');
    const s = h.$('ec-btn-save').click(); h.edit('ec-case-id', 'case-c');
    await h.answer({ ...saved, caseId: 'case-b' }); await s;
    expect(h.$('ec-case-id').value).toBe('case-c');
    expect(h.$('ec-status').textContent).not.toContain('저장됨');
  });
  it('resume preserves rich document; edit refuses lossy draft reconstruction', async () => {
    const h = harness(); const r = h.$('ec-btn-resume').click(); await h.answer(reviewed('case-a', 'rev-9', 'saved')); await r;
    const before = h.calls.length; await h.$('ec-btn-save').click();
    expect(h.calls).toHaveLength(before);
    expect(h.$('ec-json').textContent).toContain('calc-preserved');
    expect(h.$('ec-status').textContent).toContain('저장된 revision');
    h.edit('ec-collections', 'disk | 80 | GiB'); const count = h.calls.length;
    await h.$('ec-btn-save').click(); await h.$('ec-btn-review').click();
    expect(h.calls).toHaveLength(count);
    expect(h.$('ec-status').textContent).toContain('새 사례 ID');
  });
  it('export revision is invalidated and resume is required before a re-save', async () => {
    const h = harness(); const s = h.$('ec-btn-save').click(); await h.answer(reviewed()); await h.answer(saved); await s;
    const x = h.$('ec-btn-export').click(); await h.answer({ ok: true, downloadComplete: true, artifactId: 'docx', caseId: 'case-a',
      exportedCaseRevision: 'rev-1', currentCaseRevision: 'rev-x' }); await h.answer({}); await x;
    const count = h.calls.length; await h.$('ec-btn-save').click(); expect(h.calls).toHaveLength(count);
    expect(h.$('ec-status').textContent).toContain('불러오기');
  });
  it('sample invalidates review and malformed analysis never dispatches', async () => {
    const h = harness(); const r = h.$('ec-btn-review').click(); await h.answer(reviewed()); await r;
    await h.$('ec-btn-sample').click(); h.edit('ec-analysis', '{bad');
    const count = h.calls.length; await h.$('ec-btn-review').click(); expect(h.calls).toHaveLength(count);
    expect(h.$('ec-status').textContent).toContain('JSON');
  });
});

describe('generated UI failure and late-export guards', () => {
  it('resume A → new B save → B edit advances B revision without unlocking rich A', async () => {
    const h = harness();
    const a = h.$('ec-btn-resume').click(); await h.answer(reviewed('case-a', 'rev-a', 'saved')); await a;
    h.edit('ec-case-id', 'case-b'); h.edit('ec-revision', 'rev-b');
    const b = h.$('ec-btn-save').click(); await h.answer(reviewed('case-b', 'rev-b'));
    expect(h.calls.at(-1)?.body.expectedRevision).toBeUndefined();
    await h.answer({ ...saved, caseId: 'case-b', revision: 'rev-b' }); await b;
    h.edit('ec-collections', 'disk | 80 | GiB'); const revision = h.$('ec-revision').value;
    expect(revision).not.toBe('rev-b');
    const edit = h.$('ec-btn-save').click(); await h.answer(reviewed('case-b', revision));
    expect(h.calls.at(-1)?.body).toMatchObject({ expectedRevision: 'rev-b', document: { caseId: 'case-b', revision } });
    await h.answer({ ...saved, caseId: 'case-b', revision }); await edit;
    h.edit('ec-case-id', 'case-a');
    const count = h.calls.length; await h.$('ec-btn-save').click(); await h.$('ec-btn-review').click();
    expect(h.calls).toHaveLength(count);
    expect(h.$('ec-status').textContent).toContain('새 사례 ID');
  });
  it('save failure/conflict never enables export and keeps edits', async () => {
    const h = harness(); const s = h.$('ec-btn-save').click(); await h.answer(reviewed());
    await h.answer({ ok: false, status: 'unsaved', code: 'REVISION_CONFLICT' }); await s;
    expect(h.$('ec-status').textContent).toContain('저장되지 않음');
    expect(h.$('ec-collections').value).toContain('50');
    const count = h.calls.length; await h.$('ec-btn-export').click(); expect(h.calls).toHaveLength(count);
  });
  it('editing during export refuses a late download and preserves current form', async () => {
    const h = harness(); const s = h.$('ec-btn-save').click(); await h.answer(reviewed()); await h.answer(saved); await s;
    const x = h.$('ec-btn-export').click(); h.edit('ec-case-id', 'case-new');
    await h.answer({ ok: true, downloadComplete: true, caseId: 'case-a', artifactId: 'docx', currentCaseRevision: 'rev-x' }); await x;
    expect(h.$('ec-case-id').value).toBe('case-new');
    expect(h.calls.some(c => c.path.includes('guide-download'))).toBe(false);
    expect(h.$('ec-status').textContent).not.toContain('Word를 받았습니다');
  });
  it('a saved draft edit advances revision and carries only that case expectedRevision', async () => {
    const h = harness(); const s = h.$('ec-btn-save').click(); await h.answer(reviewed()); await h.answer(saved); await s;
    h.edit('ec-collections', 'disk | 80 | GiB'); const next = h.$('ec-revision').value; expect(next).not.toBe('rev-1');
    const edit = h.$('ec-btn-save').click(); expect(h.calls.at(-1)?.body.draft.revision).toBe(next);
    await h.answer(reviewed('case-a', next));
    expect(h.calls.at(-1)?.body).toMatchObject({ expectedRevision: 'rev-1', document: { revision: next } });
    await h.answer({ ...saved, revision: next }); await edit;
  });
});
