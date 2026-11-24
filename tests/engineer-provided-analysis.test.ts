import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { createOperatorServer } from '../apps/operator-console/src/server.js';
import { analyzeEngineerProvidedCase, engineerProvidedAnalysisSchema } from '../packages/sangfor-planner/src/engineer-provided-analysis.js';
import { postReviewEngineerCase } from '../apps/operator-console/src/engineer-case-review.js';
import { BlroAuthorityStore } from '../packages/sangfor-authority/src/authority-store.js';
import { ENGINEER_CASE_READ_PERMISSION, ENGINEER_CASE_WRITE_PERMISSION } from '../packages/sangfor-authority/src/authority-store-contracts.js';
import { evaluateEngineerFieldAcceptance } from '../packages/shared/src/engineer-field-acceptance.js';
import { FakeEngineerCaseAuthorityDatabase } from './helpers/engineer-case-authority-db.js';
const auth = { tenantId: 'tenant-g3', projectId: 'project-g3', actorId: 'actor-g3' };
function draft(mode: 'existing' | 'new' = 'existing'): any {
  return { caseId: 'case-' + mode, revision: 'rev-1', mode, product: 'HCI_SCP', firmware: '6.8',
    requirementLines: ['remaining >= 20 GiB'], collections: [
      { id: 'disk-limit', label: 'arbitrary one', valueText: '160', unit: 'GiB' },
      { id: 'disk-consumed', label: 'arbitrary two', valueText: '72', unit: 'GiB' },
    ], analysis: { caseRevision: 'rev-1', calculations: [{ id: 'calc-free', formulaId: 'confirmed-remaining-capacity',
      roles: { total: 'disk-limit', used: 'disk-consumed' }, outputUnit: 'GiB' }],
      bindings: [{ requirementId: 'req-1-remaining-20-gib', fieldId: 'storage_usable_capacity', calculationRef: 'calc-free' }] } };
}
const servers: ReturnType<typeof createOperatorServer>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise<void>(resolve => s.close(() => resolve())))); });
async function fixture() {
  const db = new FakeEngineerCaseAuthorityDatabase(); db.grant(auth, [ENGINEER_CASE_READ_PERMISSION, ENGINEER_CASE_WRITE_PERMISSION]);
  const authority = new BlroAuthorityStore(db);
  const store = { save: authority.saveEngineerCase.bind(authority), load: authority.loadEngineerCase.bind(authority), loadArtifact: authority.loadEngineerCaseArtifact.bind(authority) };
  const server = createOperatorServer({ engineerCase: { auth, store } }); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  const call = async (path: string, body: unknown): Promise<{ status: number; data: any }> => {
    const res = await fetch(base + '/api/engineer-cases' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };
  return { base, call, store };
}
describe('provided-only product analysis workflow (not live/field acceptance)', () => {
  it.each(['existing', 'new'] as const)('%s HTTP review → arithmetic → assessment → guide → save → resume → Word', async mode => {
    const f = await fixture(); const input = draft(mode);
    const r = await f.call('/review', { draft: input }); expect(r.status).toBe(200);
    const doc = r.data.document;
    // Independent arithmetic from supplied raw quantities, no product/helper oracle.
    expect(doc.calculations[0].result.data).toEqual({ kind: 'number', number: 160 - 72, unit: 'GiB' });
    expect(doc.calculations[0].inputRefs).toEqual(['disk-limit', 'disk-consumed']);
    expect(doc.assessments[0]).toMatchObject({ status: 'satisfied', currentRef: 'calc-free', calculationRefs: ['calc-free'] });
    expect(doc.guide.steps[0]).toMatchObject({ requirementRefs: ['req-1-remaining-20-gib'], currentRef: 'calc-free' });
    expect(doc.guide.steps[0].citations).toContain('calculation:calc-free');
    expect(doc.observations.every((o: any) => o.sourceKind === 'provided')).toBe(true);
    expect(doc).toMatchObject({ synthetic: true, originalPresent: false, environmentKind: 'fixture', execution: { result: 'not_started' } });
    expect(r.data).toMatchObject({ approved: false, guideReadyGranted: false, executionPassGranted: false });
    const s = await f.call('', { requestId: 'save-' + mode, document: doc }); expect(s.status).toBe(200); expect(s.data.status).toBe('saved');
    const resumed = await f.call('/review', { caseId: doc.caseId }); expect(resumed.status).toBe(200);
    expect(resumed.data.document.calculations).toEqual(doc.calculations);
    expect(resumed.data.document.assessments).toEqual(doc.assessments);
    const x = await f.call('/guide-export', { caseId: doc.caseId, expectedRevision: s.data.revision }); expect(x.status).toBe(200);
    const dl = await fetch(f.base + '/api/engineer-cases/guide-download?caseId=' + doc.caseId + '&artifactId=' + x.data.artifactId); expect(dl.status).toBe(200);
    const path = join(mkdtempSync(join(tmpdir(), 'g3-docx-')), 'guide.docx'); writeFileSync(path, Buffer.from(await dl.arrayBuffer()));
    const xml = execFileSync('unzip', ['-p', path, 'word/document.xml'], { encoding: 'utf8' });
    for (const text of [doc.caseId, doc.revision, '88', 'GiB', 'calc-free', 'confirmed-remaining-capacity', 'provided']) expect(xml).toContain(text);
    const after = await f.call('/review', { caseId: doc.caseId }); expect(after.data.document.revision).toBe(x.data.currentCaseRevision);
    expect(after.data.document.calculations).toEqual(doc.calculations);
    const stale = await f.call('', { requestId: 'stale-save', expectedRevision: s.data.revision, document: doc }); expect(stale.status).toBe(409);
    expect(evaluateEngineerFieldAcceptance({ environmentKind: 'fixture', synthetic: true, originalPresent: false, guideReadiness: doc.guide.readiness, wordExportOk: true, workflowCompletedNormally: true }).fieldAccepted).toBe(false);
  });
  it.each(['missing-ref', 'duplicate-calc', 'duplicate-binding', 'missing-binding', 'wrong-revision', 'extra-role', 'missing-role', 'unknown-formula', 'wrong-requirement', 'wrong-field'])( 'refuses %s without fake success', async kind => {
    const f = await fixture(); const d = draft(); const a = d.analysis;
    if (kind === 'missing-ref') a.calculations[0].roles.total = 'other-case';
    if (kind === 'duplicate-calc') a.calculations.push(a.calculations[0]);
    if (kind === 'duplicate-binding') a.bindings.push(a.bindings[0]);
    if (kind === 'missing-binding') a.bindings = [];
    if (kind === 'wrong-revision') a.caseRevision = 'old';
    if (kind === 'extra-role') a.calculations[0].roles.demand = 'disk-limit';
    if (kind === 'missing-role') delete a.calculations[0].roles.used;
    if (kind === 'unknown-formula') a.calculations[0].formulaId = 'free-form';
    if (kind === 'wrong-requirement') a.bindings[0].requirementId = 'req-other';
    if (kind === 'wrong-field') a.bindings[0].fieldId = 'label-guess';
    const r = await f.call('/review', { draft: d }); expect(r.status).toBe(400); expect(r.data.ok).not.toBe(true); expect(r.data.code || r.data.error).toBeTruthy(); expect(r.data.document).toBeUndefined();
  });
  it.each(['zero', 'unit', 'unknown', 'partial'])('keeps %s unavailable instead of zero/PASS', async kind => {
    const f = await fixture(); const d = draft();
    if (kind === 'zero') { d.collections[0].valueText = '0'; d.analysis.calculations[0].formulaId = 'confirmed-utilization-ratio'; }
    if (kind === 'unit') d.collections[1].unit = 'cores';
    if (kind === 'unknown') d.collections[0].valueText = '';
    if (kind === 'partial') d.collections[0].collectionStatus = 'partial';
    const r = await f.call('/review', { draft: d }); expect(r.status).toBe(200);
    expect(r.data.document.calculations[0].sourceKind).toBe('unknown');
    expect(r.data.document.calculations[0].result.presence).toBe('unknown');
    expect(r.data.document.assessments[0].status).toBe('unresolved'); expect(r.data.guideReadyGranted).toBe(false);
  });
  it('old draft remains compatible; malformed JSON and cross-scope claims are refused', async () => {
    const f = await fixture(); const d = draft(); delete d.analysis;
    const r = await f.call('/review', { draft: d }); expect(r.status).toBe(200); expect(r.data.document.calculations).toEqual([]);
    const bad = await fetch(f.base + '/api/engineer-cases/review', { method: 'POST', body: '{broken', headers: { 'content-type': 'application/json' } }); expect(bad.status).toBe(400);
    const c = draft(); c.analysis.projectId = 'other'; expect((await f.call('/review', { draft: c })).status).toBe(400);
  });
  it('non-HTTP caller also gets bounded schema validation', async () => {
    const f = await fixture(); const d = draft(); d.analysis.calculations[0].roles.total = 'not-present';
    const r = await postReviewEngineerCase({ draft: d }, f.store, auth); expect(r.status).toBe(400);
  });
});

describe('analysis service scope, freshness and bounded contract', () => {
  it('refuses cross-case/project source records and analysis revision drift', async () => {
    const f = await fixture(); const d = draft(); const legacy = { ...d }; delete legacy.analysis;
    const base = (await f.call('/review', { draft: legacy })).data.document;
    for (const key of ['caseId', 'projectId']) {
      const document = structuredClone(base); document.observations[0][key] = 'another-scope';
      expect(analyzeEngineerProvidedCase(document, d.analysis, auth).ok).toBe(false);
    }
    expect(analyzeEngineerProvidedCase({ ...base, revision: 'other-revision' }, d.analysis, auth).ok).toBe(false);
  });
  it('expired original freshness stays unknown and cannot become an accepted guide', async () => {
    const f = await fixture(); const d = draft(); const legacy = { ...d }; delete legacy.analysis;
    const base = (await f.call('/review', { draft: legacy })).data.document;
    base.observations[0].collectedAt = '2020-01-01T00:00:00.000Z'; base.observations[0].freshnessPolicy = { maxAgeSec: 1 };
    const r = analyzeEngineerProvidedCase(base, d.analysis, auth); expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('analysis unexpectedly refused');
    expect(r.value.calculations[0].result?.presence).toBe('unknown');
    expect(r.value.assessments[0].status).toBe('unresolved'); expect(r.guideReadyGranted).toBe(false);
  });
  it('an explicit currentRef defeats capacity keyword inference and IDs are bounded', async () => {
    const f = await fixture(); const d = draft();
    d.analysis.calculations = []; d.analysis.bindings = [{ requirementId: 'req-1-remaining-20-gib', currentRef: 'disk-consumed' }];
    const r = await f.call('/review', { draft: d }); expect(r.status).toBe(200);
    expect(r.data.document.calculations).toEqual([]); expect(r.data.document.assessments[0].currentRef).toBe('disk-consumed');
    const a = draft().analysis; expect(engineerProvidedAnalysisSchema.safeParse({ ...a, calculations: Array(65).fill(a.calculations[0]) }).success).toBe(false);
    expect(engineerProvidedAnalysisSchema.safeParse({ ...a, caseRevision: 'x'.repeat(65) }).success).toBe(false);
    expect(engineerProvidedAnalysisSchema.safeParse({ ...a, bindings: [{ ...a.bindings[0], currentRef: 'disk-consumed' }] }).success).toBe(false);
    expect(engineerProvidedAnalysisSchema.safeParse({ ...a, bindings: Array(257).fill(a.bindings[0]) }).success).toBe(false);
  });
});
