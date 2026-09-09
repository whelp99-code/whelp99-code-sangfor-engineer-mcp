import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { ENGINEER_CASE_SCHEMA_VERSION, type EngineerCaseAuthContext, type EngineerCaseDocument } from '../packages/shared/src/engineer-case-contract.js';
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
    expect(ENGINEER_CASE_PANEL).toContain('가이드 미리보기와 다운로드는 이 화면에 없습니다');
    expect(ENGINEER_CASE_ACTION_SCRIPT).toContain('이 화면에서는 가이드를 내보내지 않습니다');
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
