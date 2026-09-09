import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAPPER_VERSION, bindObservedFactToCase } from '../packages/sangfor-config-state/src/provenance.js';
import { ENGINEER_CASE_SCHEMA_VERSION, type EngineerCaseDocument } from '../packages/shared/src/engineer-case-contract.js';
import { assembleEngineerCase } from '../packages/sangfor-planner/src/engineer-case.js';
import { BlroAuthorityStore } from '../packages/sangfor-authority/src/authority-store.js';
import {
  ENGINEER_CASE_READ_PERMISSION,
  ENGINEER_CASE_WRITE_PERMISSION,
} from '../packages/sangfor-authority/src/authority-store-contracts.js';
import {
  indexEngineerCaseOriginals,
  persistEngineerCase,
  writeEngineerCaseLocalFallback,
} from '../packages/sangfor-store/src/engineer-case-store.js';
import { FakeEngineerCaseAuthorityDatabase } from './helpers/engineer-case-authority-db.js';

const AUTH = { tenantId: 'tenant-a', projectId: 'proj-a', actorId: 'actor-a' } as const;
const OTHER = { tenantId: 'tenant-b', projectId: 'proj-b', actorId: 'actor-b' } as const;
const DIGEST = 'ab'.repeat(32);
const WHEN = '2026-09-09T00:00:00.000Z';
const PERMS = [ENGINEER_CASE_READ_PERMISSION, ENGINEER_CASE_WRITE_PERMISSION];

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

describe('engineer case persistence', () => {
  it('recovers the same revision and evidence refs after a new store instance', async () => {
    const db = new FakeEngineerCaseAuthorityDatabase();
    const first = storeFor(db);
    const saved = await first.saveEngineerCase({
      auth: AUTH,
      document: fixtureCase(),
      requestId: 'req-1',
      artifacts: [{
        id: 'art-1', digest: DIGEST, mediaType: 'application/json',
        payload: '{"usable":40}', sanitized: true, retention: 'case-revision',
      }],
    });
    expect(saved).toMatchObject({ ok: true, status: 'saved', revision: 'rev-1', evidenceRefs: ['ev-1'] });

    const restarted = new BlroAuthorityStore(db);
    const loaded = await restarted.loadEngineerCase({ ...AUTH, caseId: 'case-existing-1' });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error('expected reload');
    expect(loaded.revision).toBe('rev-1');
    expect(loaded.guideDigest).toBe(DIGEST);
    expect(loaded.evidenceRefs).toEqual(['ev-1']);
    const artifact = await restarted.loadEngineerCaseArtifact({ ...AUTH, caseId: 'case-existing-1', artifactId: 'art-1' });
    expect(artifact.ok).toBe(true);
  });

  it('overwrites parse-echoed review_ready and does not grant execution PASS', async () => {
    const db = new FakeEngineerCaseAuthorityDatabase();
    const store = storeFor(db);
    const assembled = assembleEngineerCase(fixtureCase(), AUTH);
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) throw new Error('expected assemble');
    expect(assembled.guideReadyGranted).toBe(false);
    expect(assembled.value.guide.readiness).toBe('blocked');

    const saved = await store.saveEngineerCase({
      auth: AUTH,
      document: fixtureCase({ progress: 'accepted' }),
      requestId: 'req-1',
    });
    expect(saved).toMatchObject({ ok: true, guideReadyGranted: false, executionPassGranted: false, approved: false });
    const loaded = await store.loadEngineerCase({ ...AUTH, caseId: 'case-existing-1' });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error('expected load');
    expect(loaded.guideReadyGranted).toBe(false);
    expect(loaded.executionPassGranted).toBe(false);
    const document = loaded.document as EngineerCaseDocument;
    expect(document.progress).not.toBe('accepted');
    expect(document.guide.readiness).toBe(assembled.value.guide.readiness);
    expect(document.guide.readiness).not.toBe('review_ready');
    expect(document.execution.result).not.toBe('pass');
  });

  it('refuses fixture snapshots persisted as observed', async () => {
    const db = new FakeEngineerCaseAuthorityDatabase();
    const store = storeFor(db);
    const bound = bindObservedFactToCase({
      transport: 'api',
      endpoint: 'GET /volumes/detail',
      mapperVersion: MAPPER_VERSION,
      collectedAt: WHEN,
      collector: 'hci-inventory',
    }, {
      caseId: 'case-existing-1',
      projectId: AUTH.projectId,
      observationId: 'obs-usable',
      environmentKind: 'fixture',
      originalPresent: false,
    });
    expect(bound.ok).toBe(false);
    const saved = await store.saveEngineerCase({
      auth: AUTH,
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
    expect(saved.ok).toBe(false);
    if (saved.ok) throw new Error('fixture observed must not save');
    expect(saved.status).toBe('unsaved');
    expect(saved.resumable).toBe(false);
    expect(saved.approved).toBe(false);
    expect(saved.issues?.some((item) => item.code === 'FIXTURE_MARKED_OBSERVED' || item.code === 'MISSING_ORIGINAL_MARKED_OBSERVED')).toBe(true);
  });

  it('detects concurrent revision conflicts and blocks the other project', async () => {
    const db = new FakeEngineerCaseAuthorityDatabase();
    const store = storeFor(db);
    const created = await store.saveEngineerCase({ auth: AUTH, document: fixtureCase(), requestId: 'req-1' });
    expect(created.ok).toBe(true);

    const [first, second] = await Promise.all([
      store.saveEngineerCase({
        auth: AUTH,
        document: fixtureCase({ revision: 'rev-2', guide: { ...fixtureCase().guide, revision: 'guide-rev-2', readiness: 'draft' } }),
        requestId: 'req-2a',
        expectedRevision: 'rev-1',
      }),
      store.saveEngineerCase({
        auth: AUTH,
        document: fixtureCase({ revision: 'rev-2b', guide: { ...fixtureCase().guide, revision: 'guide-rev-2b', readiness: 'draft' } }),
        requestId: 'req-2b',
        expectedRevision: 'rev-1',
      }),
    ]);
    const outcomes = [first, second];
    expect(outcomes.filter((item) => item.ok).length).toBe(1);
    expect(outcomes.filter((item) => !item.ok && item.code === 'REVISION_CONFLICT').length).toBe(1);

    const foreign = await store.loadEngineerCase({ ...OTHER, caseId: 'case-existing-1' });
    expect(foreign).toMatchObject({ ok: false, status: 'unsaved', code: 'NOT_FOUND', resumable: false });
    const foreignWrite = await store.saveEngineerCase({
      auth: OTHER,
      document: fixtureCase({ caseId: 'case-existing-1' }),
      requestId: 'req-other',
    });
    expect(foreignWrite.ok).toBe(false);
  });

  it('returns unsaved when the database is down and never writes a local file', async () => {
    const db = new FakeEngineerCaseAuthorityDatabase();
    db.grant(AUTH, PERMS);
    db.unavailable = true;
    const store = new BlroAuthorityStore(db);
    const dir = mkdtempSync(join(tmpdir(), 'engineer-case-fallback-'));
    const saved = await store.saveEngineerCase({ auth: AUTH, document: fixtureCase(), requestId: 'req-down' });
    expect(saved).toMatchObject({ ok: false, status: 'unsaved', approved: false, resumable: false });
    expect(saved.ok === false && (saved.code === 'STORE_UNAVAILABLE' || saved.code === 'INDETERMINATE')).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
    expect(writeEngineerCaseLocalFallback()).toMatchObject({ ok: false, code: 'LOCAL_FALLBACK_REFUSED', status: 'unsaved' });
    expect(indexEngineerCaseOriginals()).toMatchObject({ ok: false, code: 'PUBLIC_INDEX_REFUSED' });
  });

  it('refuses a local fallback flag and does not treat storage success as guide ready', async () => {
    const db = new FakeEngineerCaseAuthorityDatabase();
    const store = storeFor(db);
    const refused = await store.saveEngineerCase({
      auth: AUTH,
      document: fixtureCase(),
      requestId: 'req-file',
      localFallback: true,
    });
    expect(refused).toMatchObject({ ok: false, code: 'LOCAL_FALLBACK_REFUSED', durable: 'unsaved', approved: false });
  });

  it('rolls back a partial artifact write and replays the same request without a new revision', async () => {
    const db = new FakeEngineerCaseAuthorityDatabase();
    const store = storeFor(db);
    db.failOn = { table: 'BlroEngineerCaseArtifact', verb: 'INSERT' };
    const partial = await store.saveEngineerCase({
      auth: AUTH,
      document: fixtureCase(),
      requestId: 'req-partial',
      artifacts: [{
        id: 'art-1', digest: DIGEST, mediaType: 'application/json',
        payload: '{"secret":"must-mask"}', sanitized: true, retention: 'case-revision',
      }],
    });
    expect(partial.ok).toBe(false);
    if (partial.ok) throw new Error('partial write must not save');
    expect(partial.status).toBe('unsaved');
    expect(await store.loadEngineerCase({ ...AUTH, caseId: 'case-existing-1' })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(db.cases.size).toBe(0);
    expect(db.artifacts.size).toBe(0);

    const first = await store.saveEngineerCase({
      auth: AUTH,
      document: fixtureCase(),
      requestId: 'req-same',
      artifacts: [{
        id: 'art-1', digest: DIGEST, mediaType: 'application/json',
        payload: '{"password":"plain"}', sanitized: true, retention: 'case-revision',
      }],
    });
    const replay = await store.saveEngineerCase({
      auth: AUTH,
      document: fixtureCase(),
      requestId: 'req-same',
      artifacts: [{
        id: 'art-1', digest: DIGEST, mediaType: 'application/json',
        payload: '{"password":"plain"}', sanitized: true, retention: 'case-revision',
      }],
    });
    expect(first.ok && replay.ok).toBe(true);
    if (!first.ok || !replay.ok) throw new Error('expected idempotent save');
    expect(replay.revision).toBe(first.revision);
    expect(db.cases.size).toBe(1);

    const conflict = await store.saveEngineerCase({
      auth: AUTH,
      document: fixtureCase({ revision: 'rev-other' }),
      requestId: 'req-same',
    });
    expect(conflict).toMatchObject({ ok: false, code: 'IDEMPOTENCY_CONFLICT', status: 'unsaved' });

    const loaded = await store.loadEngineerCase({ ...AUTH, caseId: 'case-existing-1' });
    expect(loaded.ok).toBe(true);
    const artifact = await store.loadEngineerCaseArtifact({ ...AUTH, caseId: 'case-existing-1', artifactId: 'art-1' });
    expect(artifact.ok).toBe(true);
    if (!artifact.ok) throw new Error('expected masked artifact');
    expect(artifact.payload).toContain('***');
    expect(artifact.payload).not.toContain('plain');
  });

  it('keeps an unauthorized actor from reading another project artifact', async () => {
    const db = new FakeEngineerCaseAuthorityDatabase();
    const store = storeFor(db);
    await store.saveEngineerCase({
      auth: AUTH,
      document: fixtureCase(),
      requestId: 'req-1',
      artifacts: [{
        id: 'art-1', digest: DIGEST, mediaType: 'application/json',
        payload: '{"usable":40}', sanitized: true, retention: 'case-revision',
      }],
    });
    const stolen = await store.loadEngineerCaseArtifact({ ...OTHER, caseId: 'case-existing-1', artifactId: 'art-1' });
    expect(stolen.ok).toBe(false);
    if (stolen.ok) throw new Error('cross-project artifact read');
    expect(stolen.code === 'NOT_FOUND' || stolen.code === 'ARTIFACT_NOT_FOUND' || stolen.code === 'SCOPE_UNAUTHORIZED').toBe(true);

    const stranger = { tenantId: AUTH.tenantId, projectId: AUTH.projectId, actorId: 'actor-z' };
    const denied = await store.loadEngineerCase({ ...stranger, caseId: 'case-existing-1' });
    expect(denied).toMatchObject({ ok: false, code: 'SCOPE_UNAUTHORIZED', status: 'unsaved' });
  });

  it('does not invent a durable save when the store facade has no database', async () => {
    const previous = process.env.SANGFOR_BLRO_AUTHORITY_STORE;
    process.env.SANGFOR_BLRO_AUTHORITY_STORE = 'postgres';
    delete process.env.DATABASE_URL;
    try {
      const saved = await persistEngineerCase({ auth: AUTH, document: fixtureCase(), requestId: 'req-facade' });
      expect(saved).toMatchObject({ ok: false, status: 'unsaved', approved: false, resumable: false });
      expect(saved.ok === false && (saved.code === 'LOCAL_FALLBACK_REFUSED' || saved.code === 'STORE_UNAVAILABLE')).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.SANGFOR_BLRO_AUTHORITY_STORE;
      else process.env.SANGFOR_BLRO_AUTHORITY_STORE = previous;
    }
    expect(() => readFileSync(join(tmpdir(), 'engineer-case.json'), 'utf8')).toThrow();
  });
});
