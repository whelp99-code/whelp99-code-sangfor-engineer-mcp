import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { MAPPER_VERSION } from '../packages/sangfor-config-state/src/provenance.js';
import { ENGINEER_CASE_SCHEMA_VERSION, type EngineerCaseAuthContext, type EngineerCaseDocument } from '../packages/shared/src/engineer-case-contract.js';
import { BlroAuthorityStore } from '../packages/sangfor-authority/src/authority-store.js';
import {
  ENGINEER_CASE_READ_PERMISSION,
  ENGINEER_CASE_WRITE_PERMISSION,
} from '../packages/sangfor-authority/src/authority-store-contracts.js';
import { createOperatorServer } from '../apps/operator-console/src/server.js';
import {
  defaultEngineerCaseStore,
  refuseEngineerCaseFileFallback,
  refuseEngineerCasePublicIndex,
} from '../apps/operator-console/src/engineer-case-api.js';
import { FakeEngineerCaseAuthorityDatabase } from './helpers/engineer-case-authority-db.js';
import {
  decodeOperatorRequestBody,
  parseBoundaryOperatorRequestBodyV1,
} from '../apps/operator-console/src/runtime-boundaries.js';

const AUTH = { tenantId: 'tenant-a', projectId: 'proj-a', actorId: 'actor-a' } as const;
const OTHER = { tenantId: 'tenant-b', projectId: 'proj-b', actorId: 'actor-b' } as const;
const DIGEST = 'ab'.repeat(32);
const WHEN = '2026-09-09T00:00:00.000Z';
const PERMS = [ENGINEER_CASE_READ_PERMISSION, ENGINEER_CASE_WRITE_PERMISSION];
const TOKEN = 'case-api-token';

function fixtureCase(overrides: Record<string, unknown> = {}): EngineerCaseDocument {
  return {
    schemaVersion: ENGINEER_CASE_SCHEMA_VERSION,
    caseId: 'case-existing-1',
    mode: 'existing',
    product: 'HCI_SCP',
    revision: 'rev-1',
    progress: 'draft',
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
      result: { presence: 'known', data: { kind: 'number', number: 0, unit: 'percent' } },
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
    execution: { result: 'pass', reason: 'claimed by caller' },
    ...overrides,
  } as EngineerCaseDocument;
}

function storeFor(db: FakeEngineerCaseAuthorityDatabase): BlroAuthorityStore {
  db.grant(AUTH, PERMS);
  db.grant(OTHER, PERMS);
  return new BlroAuthorityStore(db);
}

function portOf(store: BlroAuthorityStore, auth: EngineerCaseAuthContext = AUTH, token?: string): Promise<{ server: http.Server; base: string }> {
  const previous = process.env.SANGFOR_API_TOKEN;
  if (token) process.env.SANGFOR_API_TOKEN = token;
  else delete process.env.SANGFOR_API_TOKEN;
  const server = createOperatorServer({
    engineerCase: {
      store: {
        save: (input) => store.saveEngineerCase(input),
        load: (input) => store.loadEngineerCase(input),
        loadArtifact: (input) => store.loadEngineerCaseArtifact(input),
      },
      auth,
    },
  });
  if (previous === undefined) delete process.env.SANGFOR_API_TOKEN;
  else process.env.SANGFOR_API_TOKEN = previous;
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function listen(store: BlroAuthorityStore, auth: EngineerCaseAuthContext = AUTH, token?: string) {
  const started = await portOf(store, auth, token);
  servers.push(started.server);
  return started.base;
}

async function call(
  base: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

describe('engineer case API', () => {
  it('resumes the same saved revision after a new server instance', async () => {
    const db = new FakeEngineerCaseAuthorityDatabase();
    const firstStore = storeFor(db);
    const first = await listen(firstStore);
    const saved = await call(first, 'POST', '/api/engineer-cases', {
      requestId: 'req-1',
      document: fixtureCase(),
      artifacts: [{
        id: 'art-1', digest: DIGEST, mediaType: 'application/json',
        payload: '{"password":"plain"}', sanitized: true, retention: 'case-revision',
      }],
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      ok: true, status: 'saved', revision: 'rev-1', approved: false,
      guideReadyGranted: false, executionPassGranted: false, resumable: true,
    });

    const restarted = await listen(new BlroAuthorityStore(db), AUTH);
    const resumed = await call(restarted, 'GET', '/api/engineer-cases?caseId=case-existing-1');
    expect(resumed.status).toBe(200);
    expect(resumed.body).toMatchObject({
      ok: true, status: 'saved', revision: 'rev-1', guideDigest: DIGEST,
      approved: false, guideReadyGranted: false, executionPassGranted: false,
    });
    const document = resumed.body.document as EngineerCaseDocument;
    expect(document.guide.readiness).not.toBe('review_ready');
    expect(document.execution.result).not.toBe('pass');

    const compared = await call(restarted, 'POST', '/api/engineer-cases/compare', {
      caseId: 'case-existing-1', revision: 'rev-1',
    });
    expect(compared.body).toMatchObject({
      ok: true, status: 'compared', match: true, storedRevision: 'rev-1',
      approved: false, guideReadyGranted: false, executionPassGranted: false,
    });
    const artifact = await call(restarted, 'GET', '/api/engineer-cases/artifact?caseId=case-existing-1&artifactId=art-1');
    expect(artifact.status).toBe(200);
    expect(String(artifact.body.payload)).toContain('***');
    expect(String(artifact.body.payload)).not.toContain('plain');
  });

  it('refuses missing auth, forged scope, and the other project', async () => {
    const db = new FakeEngineerCaseAuthorityDatabase();
    const store = storeFor(db);
    const owned = await listen(store, AUTH, TOKEN);
    const created = await call(owned, 'POST', '/api/engineer-cases', {
      requestId: 'req-1', document: fixtureCase(),
    }, { authorization: `Bearer ${TOKEN}` });
    expect(created.status).toBe(200);

    const unauthorized = await call(owned, 'GET', '/api/engineer-cases?caseId=case-existing-1');
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.body).toEqual({ error: 'unauthorized' });

    const forged = await call(owned, 'POST', '/api/engineer-cases', {
      requestId: 'req-forged',
      document: fixtureCase({ tenantId: OTHER.tenantId, projectId: OTHER.projectId }),
    }, { authorization: `Bearer ${TOKEN}` });
    expect(forged.status).toBe(400);
    expect(forged.body).toMatchObject({ ok: false, status: 'unsaved', code: 'VALIDATION_FAILED' });

    const scoped = await listen(store, OTHER, TOKEN);
    const stolen = await call(scoped, 'GET', '/api/engineer-cases?caseId=case-existing-1', undefined, {
      authorization: `Bearer ${TOKEN}`,
    });
    expect(stolen.status).toBe(404);
    expect(stolen.body).toMatchObject({ ok: false, status: 'unsaved', code: 'NOT_FOUND', resumable: false, approved: false });
    const artifact = await call(scoped, 'POST', '/api/engineer-cases/artifact', {
      caseId: 'case-existing-1', artifactId: 'art-1',
    }, { authorization: `Bearer ${TOKEN}` });
    expect(artifact.body).toMatchObject({ ok: false, status: 'unsaved' });
    expect(['NOT_FOUND', 'ARTIFACT_NOT_FOUND']).toContain(artifact.body.code);
  });

  it('returns unsaved on revision conflict, duplicate request conflict, and partial artifact failure', async () => {
    const db = new FakeEngineerCaseAuthorityDatabase();
    const store = storeFor(db);
    const base = await listen(store);
    await call(base, 'POST', '/api/engineer-cases', { requestId: 'req-1', document: fixtureCase() });

    const [first, second] = await Promise.all([
      call(base, 'POST', '/api/engineer-cases', {
        requestId: 'req-2a',
        expectedRevision: 'rev-1',
        document: fixtureCase({ revision: 'rev-2', guide: { ...fixtureCase().guide, revision: 'guide-rev-2', readiness: 'draft' } }),
      }),
      call(base, 'POST', '/api/engineer-cases', {
        requestId: 'req-2b',
        expectedRevision: 'rev-1',
        document: fixtureCase({ revision: 'rev-2b', guide: { ...fixtureCase().guide, revision: 'guide-rev-2b', readiness: 'draft' } }),
      }),
    ]);
    expect([first, second].filter((item) => item.body.ok === true)).toHaveLength(1);
    expect([first, second].filter((item) => item.body.code === 'REVISION_CONFLICT')).toHaveLength(1);
    expect([first, second].find((item) => item.body.code === 'REVISION_CONFLICT')?.body).toMatchObject({
      ok: false, status: 'unsaved', approved: false, resumable: false,
    });

    const stale = await call(base, 'POST', '/api/engineer-cases/compare', {
      caseId: 'case-existing-1', revision: 'rev-missing',
    });
    expect(stale.body).toMatchObject({ ok: true, status: 'compared', match: false, approved: false });

    db.failOn = { table: 'BlroEngineerCaseArtifact', verb: 'INSERT' };
    const partial = await call(base, 'POST', '/api/engineer-cases', {
      requestId: 'req-partial',
      document: fixtureCase({ caseId: 'case-partial', revision: 'rev-p' }),
      artifacts: [{
        id: 'art-1', digest: DIGEST, mediaType: 'application/json',
        payload: '{"usable":40}', sanitized: true, retention: 'case-revision',
      }],
    });
    expect(partial.body).toMatchObject({ ok: false, status: 'unsaved', approved: false, resumable: false });
    expect(await call(base, 'POST', '/api/engineer-cases/resume', { caseId: 'case-partial' })).toMatchObject({
      body: { ok: false, code: 'NOT_FOUND', status: 'unsaved' },
    });

    const once = await call(base, 'POST', '/api/engineer-cases', {
      requestId: 'req-same', document: fixtureCase({ caseId: 'case-idemp', revision: 'rev-i' }),
    });
    const replay = await call(base, 'POST', '/api/engineer-cases', {
      requestId: 'req-same', document: fixtureCase({ caseId: 'case-idemp', revision: 'rev-i' }),
    });
    expect(once.body).toMatchObject({ ok: true, revision: 'rev-i' });
    expect(replay.body).toMatchObject({ ok: true, revision: 'rev-i' });
    const conflict = await call(base, 'POST', '/api/engineer-cases', {
      requestId: 'req-same', document: fixtureCase({ caseId: 'case-idemp', revision: 'rev-other' }),
    });
    expect(conflict).toMatchObject({ status: 409, body: { ok: false, code: 'IDEMPOTENCY_CONFLICT', status: 'unsaved' } });
  });

  it('refuses postgres-mode file fallback and does not treat storage as guide ready', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'engineer-case-api-'));
    const previousStore = process.env.SANGFOR_BLRO_AUTHORITY_STORE;
    const previousDb = process.env.DATABASE_URL;
    process.env.SANGFOR_BLRO_AUTHORITY_STORE = 'postgres';
    delete process.env.DATABASE_URL;
    const server = createOperatorServer({
      engineerCase: { store: defaultEngineerCaseStore(), auth: AUTH },
    });
    servers.push(server);
    const base = await new Promise<string>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo;
        resolve(`http://127.0.0.1:${port}`);
      });
    });
    try {
      const saved = await call(base, 'POST', '/api/engineer-cases', {
        requestId: 'req-pg', document: fixtureCase(),
      });
      expect(saved.body).toMatchObject({ ok: false, status: 'unsaved', approved: false, resumable: false });
      expect(['LOCAL_FALLBACK_REFUSED', 'STORE_UNAVAILABLE']).toContain(saved.body.code);
      expect(saved.body.status).not.toBe('saved');
      expect(saved.body.status).not.toBe('accepted');
      expect(readdirSync(dir)).toEqual([]);
      expect(refuseEngineerCaseFileFallback()).toMatchObject({ ok: false, code: 'LOCAL_FALLBACK_REFUSED', status: 'unsaved' });
      expect(refuseEngineerCasePublicIndex()).toMatchObject({ ok: false, code: 'PUBLIC_INDEX_REFUSED' });
    } finally {
      if (previousStore === undefined) delete process.env.SANGFOR_BLRO_AUTHORITY_STORE;
      else process.env.SANGFOR_BLRO_AUTHORITY_STORE = previousStore;
      if (previousDb === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDb;
    }

    expect(() => decodeOperatorRequestBody(
      parseBoundaryOperatorRequestBodyV1(JSON.stringify({
        requestId: 'req-1', document: { caseId: 'x' }, localFallback: true,
      })),
      'engineer-cases',
    )).toThrow();

    const db = new FakeEngineerCaseAuthorityDatabase();
    const live = await listen(storeFor(db));
    const fileFlag = await call(live, 'POST', '/api/engineer-cases', {
      requestId: 'req-file', document: fixtureCase(), localFallback: true,
    });
    expect(fileFlag.status).toBe(400);
    expect(fileFlag.body.status).not.toBe('saved');
    expect(fileFlag.body.status).not.toBe('accepted');
    const observed = await call(live, 'POST', '/api/engineer-cases', {
      requestId: 'req-obs',
      document: fixtureCase({
        observations: [{
          id: 'obs-usable',
          sourceKind: 'observed',
          collectionStatus: 'complete',
          collectedAt: WHEN,
          factProvenance: {
            transport: 'api',
            endpoint: 'GET /volumes/detail',
            mapperVersion: MAPPER_VERSION,
            collectedAt: WHEN,
            collector: 'hci-inventory',
          },
          value: { presence: 'known', data: { kind: 'integer', integer: 1, unit: 'count' } },
        }],
      }),
    });
    expect(observed.body).toMatchObject({ ok: false, status: 'unsaved', approved: false });
    expect((observed.body.issues as Array<{ code: string }> | undefined)?.some((item) => (
      item.code === 'FIXTURE_MARKED_OBSERVED' || item.code === 'MISSING_ORIGINAL_MARKED_OBSERVED'
    ))).toBe(true);
  });

  it('returns unsaved when the authenticated scope is missing', async () => {
    const server = createOperatorServer({
      engineerCase: {
        store: {
          save: async () => ({ ok: true, status: 'saved' } as never),
          load: async () => ({ ok: true, status: 'saved' } as never),
          loadArtifact: async () => ({ ok: true } as never),
        },
        env: {},
      },
    });
    servers.push(server);
    const base = await new Promise<string>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo;
        resolve(`http://127.0.0.1:${port}`);
      });
    });
    const missing = await call(base, 'POST', '/api/engineer-cases', {
      requestId: 'req-1', document: fixtureCase(),
    });
    expect(missing).toMatchObject({
      status: 401,
      body: { ok: false, status: 'unsaved', code: 'SCOPE_UNAUTHORIZED', approved: false, resumable: false },
    });
  });
});
