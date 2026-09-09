import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { computeEngineerGuideDigest, ENGINEER_CASE_SCHEMA_VERSION, type EngineerCaseAuthContext, type EngineerCaseDocument, type EngineerGuide } from '../packages/shared/src/engineer-case-contract.js';
import { BlroAuthorityStore } from '../packages/sangfor-authority/src/authority-store.js';
import {
  ENGINEER_CASE_READ_PERMISSION,
  ENGINEER_CASE_WRITE_PERMISSION,
} from '../packages/sangfor-authority/src/authority-store-contracts.js';
import { unsavedEngineerCase as unsaved } from '../packages/sangfor-authority/src/engineer-case-persistence.js';
import { createOperatorServer } from '../apps/operator-console/src/server.js';
import { projectEngineerCaseReview } from '../apps/operator-console/src/engineer-case-review.js';
import { ENGINEER_CASE_ACTION_SCRIPT } from '../apps/operator-console/src/ui-engineer-case-actions.js';
import { ENGINEER_CASE_PANEL } from '../apps/operator-console/src/ui-engineer-case-layout.js';
import { FakeEngineerCaseAuthorityDatabase } from './helpers/engineer-case-authority-db.js';
import {
  decodeOperatorRequestBody,
  parseBoundaryOperatorRequestBodyV1,
} from '../apps/operator-console/src/runtime-boundaries.js';
import { RuntimeSchemaError } from '../packages/shared/src/runtime-schema.js';

const AUTH = { tenantId: 'tenant-a', projectId: 'proj-a', actorId: 'actor-a' } as const;
const OTHER = { tenantId: 'tenant-b', projectId: 'proj-b', actorId: 'actor-b' } as const;
const DIGEST = 'ab'.repeat(32);
const WHEN = '2026-09-09T00:00:00.000Z';
const PERMS = [ENGINEER_CASE_READ_PERMISSION, ENGINEER_CASE_WRITE_PERMISSION];
const TOKEN = 'case-review-token';

function fixtureCase(overrides: Record<string, unknown> = {}): EngineerCaseDocument {
  return {
    schemaVersion: ENGINEER_CASE_SCHEMA_VERSION,
    caseId: 'case-existing-1',
    mode: 'existing',
    product: 'HCI_SCP',
    revision: 'rev-1',
    progress: 'accepted',
    environmentKind: 'fixture',
    synthetic: true,
    originalPresent: false,
    observations: [{
      id: 'obs-usable',
      sourceKind: 'provided',
      collectionStatus: 'complete',
      collectedAt: WHEN,
      value: { presence: 'known', data: { kind: 'number', number: 40, unit: 'TiB' } },
    }],
    requirements: [{
      id: 'req-headroom',
      sourceKind: 'provided',
      sourceRef: 'excel-row-1',
      constraint: 'headroom >= 20 percent',
      priority: 'high',
      confirmationState: 'unconfirmed',
      acceptanceCriterion: 'usable headroom remains above 20 percent',
      revision: 'req-rev-1',
    }],
    calculations: [{
      id: 'calc-headroom',
      sourceKind: 'derived',
      formulaId: 'usable-headroom-ratio',
      formulaVersion: '1.0.0',
      inputRefs: ['obs-usable'],
      assumptions: ['usable capacity is the provided fixture value'],
      result: { presence: 'unknown', reason: '공식 입력이 부족합니다' },
      unavailableReason: '공식 입력이 부족합니다',
    }],
    assessments: [{
      id: 'assess-headroom',
      requirementRef: 'req-headroom',
      currentRef: 'obs-usable',
      calculationRefs: ['calc-headroom'],
      status: 'unresolved',
      reasons: ['usable capacity is provided, not observed'],
      nextAction: 'recollect',
    }],
    guide: {
      revision: 'guide-rev-1',
      digest: DIGEST,
      requirementRefs: ['req-headroom'],
      steps: [],
      prerequisites: [],
      unresolved: ['usable capacity is provided, not observed'],
      readiness: 'review_ready',
    },
    evidence: [{
      id: 'ev-1',
      digest: DIGEST,
      mediaType: 'application/json',
      sanitized: true,
      retention: 'case-revision',
    }],
    execution: { result: 'indeterminate', reason: 'not an execution PASS' },
    ...overrides,
  } as EngineerCaseDocument;
}

function storeFor(db: FakeEngineerCaseAuthorityDatabase): BlroAuthorityStore {
  db.grant(AUTH, PERMS);
  db.grant(OTHER, PERMS);
  return new BlroAuthorityStore(db);
}

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function listen(
  store: BlroAuthorityStore | { save: BlroAuthorityStore['saveEngineerCase']; load: BlroAuthorityStore['loadEngineerCase']; loadArtifact: BlroAuthorityStore['loadEngineerCaseArtifact'] },
  auth: EngineerCaseAuthContext | null = AUTH,
  token?: string,
): Promise<string> {
  const previous = process.env.SANGFOR_API_TOKEN;
  if (token) process.env.SANGFOR_API_TOKEN = token;
  else delete process.env.SANGFOR_API_TOKEN;
  const server = createOperatorServer({
    engineerCase: {
      store: 'saveEngineerCase' in store
        ? { save: (input) => store.saveEngineerCase(input), load: (input) => store.loadEngineerCase(input), loadArtifact: (input) => store.loadEngineerCaseArtifact(input) }
        : store,
      ...(auth ? { auth } : { env: {} }),
    },
  });
  if (previous === undefined) delete process.env.SANGFOR_API_TOKEN;
  else process.env.SANGFOR_API_TOKEN = previous;
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function call(
  base: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

function withGuideDigest(guide: Omit<EngineerGuide, 'digest'>): EngineerGuide {
  return { ...guide, digest: computeEngineerGuideDigest(guide) };
}

/** E08-style review_ready guide whose digest matches the incoming fields. Persist must rewrite readiness and refresh digest. */
function e08ReviewReadyCase(): EngineerCaseDocument {
  return {
    schemaVersion: ENGINEER_CASE_SCHEMA_VERSION,
    caseId: 'case-e08-ready-1',
    mode: 'existing',
    product: 'HCI_SCP',
    firmware: '6.7.0',
    revision: 'rev-1',
    progress: 'draft',
    environmentKind: 'fixture',
    synthetic: true,
    originalPresent: false,
    observations: [
      {
        id: 'obs-total',
        sourceKind: 'provided',
        collectionStatus: 'complete',
        collectedAt: WHEN,
        evidenceRef: 'ev-1',
        value: { presence: 'known', data: { kind: 'number', number: 100, unit: 'GiB' } },
      },
      {
        id: 'obs-used',
        sourceKind: 'provided',
        collectionStatus: 'complete',
        collectedAt: WHEN,
        evidenceRef: 'ev-1',
        value: { presence: 'known', data: { kind: 'number', number: 40, unit: 'GiB' } },
      },
      {
        id: 'obs-fraction',
        sourceKind: 'provided',
        collectionStatus: 'complete',
        collectedAt: WHEN,
        evidenceRef: 'ev-1',
        value: { presence: 'known', data: { kind: 'number', number: 12.25, unit: 'GiB' } },
      },
    ],
    requirements: [
      {
        id: 'req-remaining',
        sourceKind: 'provided',
        sourceRef: 'excel-row-1',
        constraint: 'remaining >= 20 GiB',
        priority: 'high',
        confirmationState: 'confirmed',
        acceptanceCriterion: 'remaining >= 20 GiB',
        revision: 'req-rev-1',
      },
      {
        id: 'req-ha',
        sourceKind: 'provided',
        sourceRef: 'excel-row-2',
        constraint: 'HA enabled',
        priority: 'high',
        confirmationState: 'confirmed',
        acceptanceCriterion: 'HA enabled',
        revision: 'req-rev-1',
      },
    ],
    calculations: [{
      id: 'calc-remaining',
      sourceKind: 'derived',
      formulaId: 'remaining-capacity',
      formulaVersion: '1.0.0',
      inputRefs: ['obs-total', 'obs-used'],
      assumptions: ['usable capacity is the provided fixture value'],
      result: { presence: 'known', data: { kind: 'number', number: 60, unit: 'GiB' } },
    }],
    assessments: [{
      id: 'assess-remaining',
      requirementRef: 'req-remaining',
      currentRef: 'calc-remaining',
      calculationRefs: ['calc-remaining'],
      status: 'unresolved',
      reasons: ['usable capacity is provided, not observed'],
      nextAction: 'recollect',
    }],
    guide: withGuideDigest({
      revision: 'guide-rev-1',
      requirementRefs: ['req-remaining', 'req-ha'],
      steps: [{
        id: 'step-1',
        order: 1,
        title: 'Confirm remaining capacity',
        requirementRefs: ['req-remaining'],
        currentRef: 'obs-total',
        proposedRef: 'calc-remaining',
        evidenceRefs: ['ev-1'],
        citations: ['ev-1'],
        verify: 'Read remaining after change',
        stop: 'Stop if remaining is unknown',
        recovery: 'Do not apply a guessed value',
      }],
      prerequisites: ['saved case'],
      unresolved: ['usable capacity is provided, not observed'],
      readiness: 'review_ready',
    }),
    evidence: [{
      id: 'ev-1',
      owner: { tenantId: AUTH.tenantId, projectId: AUTH.projectId, caseId: 'case-e08-ready-1' },
      digest: DIGEST,
      mediaType: 'application/json',
      sanitized: true,
      retention: 'case-revision',
    }],
    execution: { result: 'not_started' },
  };
}

const draft = {
  caseId: 'case-review-1',
  mode: 'existing' as const,
  product: 'HCI_SCP',
  firmware: '',
  requirementLines: ['가용 용량 여유 20% 이상 유지'],
  collections: [
    { label: 'usable-capacity', valueText: '40', unit: 'TiB' },
    { label: 'host-cpu', valueText: '', unit: 'cores' },
  ],
};

describe('engineer case review projection', () => {
  it('does not treat accepted or review_ready as approved or complete', () => {
    const view = projectEngineerCaseReview(fixtureCase());
    expect(view.complete).toBe(false);
    expect(view.collectionConnected).toBe(false);
    expect(view.progressClaim).toContain('accepted');
    expect(view.progressClaim).toContain('승인·현장 인수 아님');
    expect(view.failures).toEqual(expect.arrayContaining(['계산 불가', '장비 수집이 연결되어 있지 않습니다']));
    expect(view.observations[0]?.sourceKindLabel).toBe('제공값');
    expect(view.calculations[0]?.detail).toContain('계산 불가');
  });
});

describe('engineer case review HTTP', () => {
  it('reviews a draft without granting ready or save-complete', async () => {
    const base = await listen(storeFor(new FakeEngineerCaseAuthorityDatabase()));
    const reviewed = await call(base, '/api/engineer-cases/review', { draft });
    expect(reviewed.status).toBe(200);
    expect(reviewed.body).toMatchObject({
      ok: true,
      status: 'reviewed',
      durable: 'unsaved',
      approved: false,
      guideReadyGranted: false,
      executionPassGranted: false,
      collectionConnected: false,
      saveComplete: false,
    });
    const review = reviewed.body.review as { observations: Array<{ sourceKindLabel: string }>; failures: string[]; complete: boolean };
    expect(review.complete).toBe(false);
    expect(review.observations.map((item) => item.sourceKindLabel)).toEqual(['제공값', '미확인']);
    expect(review.failures).toEqual(expect.arrayContaining(['계산 불가', '장비 수집이 연결되어 있지 않습니다']));
    const document = reviewed.body.document as EngineerCaseDocument;
    expect(document.guide.readiness).not.toBe('review_ready');
    expect(document.execution.result).not.toBe('pass');
    expect(document.progress).not.toBe('accepted');
  });

  it('saves only when status is saved and still withholds grants', async () => {
    const base = await listen(storeFor(new FakeEngineerCaseAuthorityDatabase()));
    const reviewed = await call(base, '/api/engineer-cases/review', { draft });
    const saved = await call(base, '/api/engineer-cases', {
      requestId: 'req-review-1',
      document: reviewed.body.document,
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      ok: true, status: 'saved', approved: false, guideReadyGranted: false, executionPassGranted: false,
    });
    expect(saved.body.status).not.toBe('reviewed');
    const resumed = await call(base, '/api/engineer-cases/review', { caseId: 'case-review-1' });
    expect(resumed.body).toMatchObject({
      ok: true, status: 'reviewed', durable: 'saved', approved: false, saveComplete: false, collectionConnected: false,
    });
  });

  it('keeps 401, store failure, revision conflict, and cross-case artifact unsaved', async () => {
    const db = new FakeEngineerCaseAuthorityDatabase();
    const store = storeFor(db);
    const gated = await listen(store, AUTH, TOKEN);
    const unauth = await call(gated, '/api/engineer-cases/review', { draft });
    expect(unauth.status).toBe(401);
    expect(unauth.body).toMatchObject({ error: 'unauthorized' });
    const noScope = await listen(store, null);
    const scope = await call(noScope, '/api/engineer-cases/review', { draft });
    expect(scope.status).toBe(401);
    expect(scope.body).toMatchObject({ ok: false, status: 'unsaved', code: 'SCOPE_UNAUTHORIZED', approved: false });

    const failing = await listen({
      save: async () => unsaved('STORE_UNAVAILABLE'),
      load: async () => unsaved('STORE_UNAVAILABLE'),
      loadArtifact: async () => unsaved('STORE_UNAVAILABLE'),
    });
    const reviewed = await call(failing, '/api/engineer-cases/review', { draft: { ...draft, caseId: 'case-fail-1' } });
    const failedSave = await call(failing, '/api/engineer-cases', {
      requestId: 'req-fail-1',
      document: reviewed.body.document,
    });
    expect(failedSave.body).toMatchObject({ ok: false, status: 'unsaved', code: 'STORE_UNAVAILABLE', approved: false });
    expect(failedSave.body.status).not.toBe('saved');

    const live = await listen(store);
    const first = await call(live, '/api/engineer-cases/review', { draft: { ...draft, caseId: 'case-conflict-1' } });
    await call(live, '/api/engineer-cases', { requestId: 'req-c1', document: first.body.document });
    const conflict = await call(live, '/api/engineer-cases', {
      requestId: 'req-c2',
      document: { ...(first.body.document as object), revision: 'rev-other' },
      expectedRevision: 'rev-stale',
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ ok: false, status: 'unsaved', code: 'REVISION_CONFLICT' });

    const other = await listen(store, OTHER);
    const artifact = await call(other, '/api/engineer-cases/artifact', { caseId: 'case-conflict-1', artifactId: 'ev-1' });
    expect(artifact.status).toBe(404);
    expect(artifact.body).toMatchObject({ ok: false, status: 'unsaved' });
    expect(['NOT_FOUND', 'ARTIFACT_NOT_FOUND']).toContain(artifact.body.code);
  });

  it('does not treat compare as a save', async () => {
    const base = await listen(storeFor(new FakeEngineerCaseAuthorityDatabase()));
    const reviewed = await call(base, '/api/engineer-cases/review', { draft: { ...draft, caseId: 'case-compare-1' } });
    await call(base, '/api/engineer-cases', { requestId: 'req-cmp', document: reviewed.body.document });
    const compared = await call(base, '/api/engineer-cases/compare', { caseId: 'case-compare-1', revision: 'missing' });
    expect(compared.body).toMatchObject({
      ok: true, status: 'compared', approved: false, guideReadyGranted: false, executionPassGranted: false,
    });
    expect(compared.body.status).not.toBe('saved');
  });
});

describe('engineer case review UI contract', () => {
  it('keys completion off envelope grants and saved status only', () => {
    expect(ENGINEER_CASE_ACTION_SCRIPT).toContain("data.status === 'saved'");
    expect(ENGINEER_CASE_ACTION_SCRIPT).toContain('guideReadyGranted');
    expect(ENGINEER_CASE_ACTION_SCRIPT).toContain('executionPassGranted');
    expect(ENGINEER_CASE_ACTION_SCRIPT).not.toContain("document.progress === 'accepted'");
    expect(ENGINEER_CASE_ACTION_SCRIPT).not.toContain("readiness === 'review_ready'");
    expect(ENGINEER_CASE_PANEL).toContain('가이드 미리보기');
    expect(ENGINEER_CASE_PANEL).toContain('처음 쓰는 경우');
    expect(ENGINEER_CASE_ACTION_SCRIPT).toContain('/api/engineer-cases/guide-export');
    expect(ENGINEER_CASE_ACTION_SCRIPT).toContain('/api/engineer-cases/guide-download');
    expect(ENGINEER_CASE_ACTION_SCRIPT).toContain('downloadComplete');
    expect(ENGINEER_CASE_ACTION_SCRIPT).toContain('exportedCaseRevision');
    expect(ENGINEER_CASE_ACTION_SCRIPT).not.toContain('progress === \'accepted\'');
  });

  it('exports Word only after a saved case and blocks cross-case download', async () => {
    const db = new FakeEngineerCaseAuthorityDatabase();
    const store = storeFor(db);
    const base = await listen(store);
    const unsaved = await call(base, '/api/engineer-cases/guide-export', { caseId: 'case-missing-1' });
    expect(unsaved.body).toMatchObject({ ok: false, status: 'unsaved', downloadComplete: false, approved: false });
    expect(unsaved.body.status).not.toBe('exported');

    const reviewed = await call(base, '/api/engineer-cases/review', { draft: { ...draft, caseId: 'case-guide-1' } });
    const saved = await call(base, '/api/engineer-cases', {
      requestId: 'req-guide-1',
      document: reviewed.body.document,
    });
    expect(saved.body).toMatchObject({ ok: true, status: 'saved' });
    const exported = await call(base, '/api/engineer-cases/guide-export', { caseId: 'case-guide-1' });
    expect(exported.status).toBe(200);
    expect(exported.body).toMatchObject({
      ok: true,
      status: 'exported',
      downloadComplete: true,
      approved: false,
      guideReadyGranted: false,
      executionPassGranted: false,
      fieldAccepted: false,
      artifactId: 'gdocx-1',
    });
    expect(exported.body.exportedCaseRevision).toBeTruthy();
    expect(String(JSON.stringify(exported.body))).not.toMatch(/\/home\/|outputPath|absPath/);

    const file = await fetch(`${base}/api/engineer-cases/guide-download?caseId=case-guide-1&artifactId=gdocx-1`);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toContain('wordprocessingml');
    const bytes = Buffer.from(await file.arrayBuffer());
    expect(bytes.subarray(0, 2).toString()).toBe('PK');

    const other = await listen(store, OTHER);
    const stolen = await fetch(`${other}/api/engineer-cases/guide-download?caseId=case-guide-1&artifactId=gdocx-1`);
    expect(stolen.status).toBe(404);
    expect(await stolen.json()).toMatchObject({ ok: false, downloadComplete: false });

    const traversal = await fetch(`${base}/api/engineer-cases/guide-download?caseId=case-guide-1&artifactId=../secret`);
    expect(traversal.status).toBe(400);
  });

  it('exports and downloads a saved E08 review_ready guide after persist rewrites readiness', async () => {
    const incoming = e08ReviewReadyCase();
    expect(incoming.guide.readiness).toBe('review_ready');
    const base = await listen(storeFor(new FakeEngineerCaseAuthorityDatabase()));
    const saved = await call(base, '/api/engineer-cases', {
      requestId: 'req-e08-1',
      document: incoming,
    });
    expect(saved.body).toMatchObject({ ok: true, status: 'saved', approved: false, guideReadyGranted: false });
    const resumed = await call(base, '/api/engineer-cases/review', { caseId: incoming.caseId });
    const stored = resumed.body.document as EngineerCaseDocument;
    const { digest: storedDigest, ...storedFields } = stored.guide;
    expect(stored.guide.readiness).toBe('blocked');
    expect(stored.guide.readiness).not.toBe('review_ready');
    expect(storedDigest).toBe(computeEngineerGuideDigest(storedFields));
    expect(storedDigest).not.toBe(incoming.guide.digest);

    const exported = await call(base, '/api/engineer-cases/guide-export', { caseId: incoming.caseId });
    expect(exported.status).toBe(200);
    expect(exported.body).toMatchObject({
      ok: true,
      status: 'exported',
      downloadComplete: true,
      artifactId: 'gdocx-1',
      approved: false,
      guideReadyGranted: false,
      executionPassGranted: false,
      fieldAccepted: false,
      recomputed: false,
    });

    const file = await fetch(`${base}/api/engineer-cases/guide-download?caseId=${incoming.caseId}&artifactId=gdocx-1`);
    expect(file.status).toBe(200);
    const bytes = Buffer.from(await file.arrayBuffer());
    expect(bytes.subarray(0, 2).toString()).toBe('PK');
    const extract = mkdtempSync(join(tmpdir(), 'e10b-e08-docx-'));
    const docxPath = join(extract, 'saved-e08.docx');
    writeFileSync(docxPath, bytes);
    const xml = execFileSync('unzip', ['-p', docxPath, 'word/document.xml'], { encoding: 'utf8', maxBuffer: 10_000_000 });
    expect(xml).toContain('60 GiB');
    expect(xml).toContain('12.25 GiB');
    expect(xml).toContain('초안');
    expect(xml).toContain('blocked');
    expect(xml).not.toContain('문서 상태: review_ready');
  });

  it('keeps the generated document revision when the stored case changes during export', async () => {
    const db = new FakeEngineerCaseAuthorityDatabase();
    const inner = storeFor(db);
    const setup = await listen(inner);
    const reviewed = await call(setup, '/api/engineer-cases/review', { draft: { ...draft, caseId: 'case-shift-1' } });
    await call(setup, '/api/engineer-cases', { requestId: 'req-shift-1', document: reviewed.body.document });
    const first = await inner.loadEngineerCase({ ...AUTH, caseId: 'case-shift-1' });
    if (!first.ok) throw new Error('expected saved case');
    let loads = 0;
    const shifting = await listen({
      save: async () => unsaved('REVISION_CONFLICT'),
      load: async (input) => {
        loads += 1;
        if (loads === 1) return first;
        return { ...first, revision: 'rev-later', document: { ...(first.document as object), revision: 'rev-later' } };
      },
      loadArtifact: (input) => inner.loadEngineerCaseArtifact(input),
    });
    const exported = await call(shifting, '/api/engineer-cases/guide-export', { caseId: 'case-shift-1' });
    expect(exported.body).toMatchObject({
      ok: false,
      status: 'unsaved',
      downloadComplete: false,
      exportedCaseRevision: first.revision,
      currentCaseRevision: 'rev-later',
      approved: false,
    });
    expect(exported.body.exportedCaseRevision).not.toBe('rev-later');
    expect(exported.body.status).not.toBe('exported');
  });

  it('rejects a tenant claim on the review route', () => {
    const parse = () => decodeOperatorRequestBody(
      parseBoundaryOperatorRequestBodyV1(JSON.stringify({
        draft: { ...draft, tenantId: 'tenant-forged' },
      })),
      'engineer-cases-review',
    );
    expect(parse).toThrow(RuntimeSchemaError);
  });
});
