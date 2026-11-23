import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BlroAuthorityStore } from '../../packages/sangfor-authority/src/authority-store.js';
import { ENGINEER_CASE_SCHEMA_VERSION, type EngineerCaseDocument } from '../../packages/shared/src/engineer-case-contract.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL?.trim()) throw new Error('DATABASE_URL is required for mandatory Postgres engineer-case persistence');

const suffix = randomUUID();
const tenantId = `e09a-tenant-${suffix}`;
const projectId = `e09a-project-${suffix}`;
const otherProjectId = `e09a-other-${suffix}`;
const actorId = `e09a-actor-${suffix}`;
const otherActorId = `e09a-actor-b-${suffix}`;
const roleId = `e09a-role-${suffix}`;
const DIGEST = 'cd'.repeat(32);
const AUTH = { tenantId, projectId, actorId } as const;
const OTHER = { tenantId, projectId: otherProjectId, actorId: otherActorId } as const;

function document(revision = 'rev-1'): EngineerCaseDocument {
  return {
    schemaVersion: ENGINEER_CASE_SCHEMA_VERSION,
    caseId: `case-${suffix}`.slice(0, 64),
    mode: 'existing',
    product: 'HCI_SCP',
    revision,
    progress: 'draft',
    environmentKind: 'fixture',
    synthetic: true,
    originalPresent: false,
    observations: [{
      id: 'obs-usable',
      sourceKind: 'provided',
      collectionStatus: 'complete',
      value: { presence: 'known', data: { kind: 'number', number: 8, unit: 'TiB' } },
    }],
    requirements: [{
      id: 'req-headroom',
      sourceKind: 'provided',
      sourceRef: 'excel-row-1',
      priority: 'high',
      confirmationState: 'unconfirmed',
      acceptanceCriterion: 'headroom remains',
      revision: 'req-rev-1',
    }],
    calculations: [{
      id: 'calc-headroom',
      sourceKind: 'derived',
      formulaId: 'usable-headroom-ratio',
      formulaVersion: '1.0.0',
      inputRefs: ['obs-usable'],
      assumptions: ['fixture'],
      result: { presence: 'known', data: { kind: 'number', number: 0, unit: 'percent' } },
    }],
    assessments: [{
      id: 'assess-headroom',
      requirementRef: 'req-headroom',
      currentRef: 'obs-usable',
      calculationRefs: ['calc-headroom'],
      status: 'unresolved',
      reasons: ['fixture'],
      nextAction: 'recollect',
    }],
    guide: {
      revision: `guide-${revision}`,
      digest: DIGEST,
      requirementRefs: ['req-headroom'],
      steps: [],
      prerequisites: [],
      unresolved: ['fixture'],
      readiness: 'review_ready',
    },
    evidence: [{
      id: 'ev-1',
      digest: DIGEST,
      mediaType: 'application/json',
      sanitized: true,
      retention: 'case-revision',
    }],
    execution: { result: 'not_started' },
  };
}

describe('engineer case persistence on Postgres', () => {
  let prisma: PrismaClient;
  let store: BlroAuthorityStore;
  const caseId = `case-${suffix}`.slice(0, 64);

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
    store = new BlroAuthorityStore(prisma);
    await prisma.$executeRawUnsafe(`INSERT INTO "BlroTenant" ("id","name") VALUES ($1,$2)`, tenantId, 'E09A');
    for (const [id, actor] of [[projectId, actorId], [otherProjectId, otherActorId]] as const) {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('app.project_id', $1, true)`, id);
        await tx.$executeRawUnsafe(`INSERT INTO "BlroProject" ("id","tenantId","name") VALUES ($1,$2,$3)`, id, tenantId, id);
        await tx.$executeRawUnsafe(
          `INSERT INTO "BlroActor" ("id","tenantId","displayName","actorType") VALUES ($1,$2,$3,'human_pm') ON CONFLICT ("id") DO NOTHING`,
          actor, tenantId, actor,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO "BlroRole" ("id","tenantId","name","permissions") VALUES ($1,$2,$3,ARRAY['case:read','case:write']) ON CONFLICT ("id") DO NOTHING`,
          roleId, tenantId, 'E09A writer',
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO "BlroMembership" ("id","projectId","actorId","tenantId","roleId") VALUES ($1,$2,$3,$4,$5)`,
          `mem-${id}`, id, actor, tenantId, roleId,
        );
      });
    }
  });

  afterAll(async () => {
    for (const id of [projectId, otherProjectId]) {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('app.project_id', $1, true)`, id);
        await tx.$executeRawUnsafe(`DELETE FROM "BlroEngineerCaseArtifact" WHERE "projectId"=$1`, id);
        await tx.$executeRawUnsafe(`DELETE FROM "BlroEngineerCase" WHERE "projectId"=$1`, id);
        await tx.$executeRawUnsafe(`DELETE FROM "BlroMembership" WHERE "projectId"=$1`, id);
        await tx.$executeRawUnsafe(`DELETE FROM "BlroProject" WHERE "id"=$1`, id);
      });
    }
    await prisma.$executeRawUnsafe(`DELETE FROM "BlroRole" WHERE "id"=$1`, roleId);
    await prisma.$executeRawUnsafe(`DELETE FROM "BlroActor" WHERE "id" IN ($1,$2)`, actorId, otherActorId);
    await prisma.$executeRawUnsafe(`DELETE FROM "BlroTenant" WHERE "id"=$1`, tenantId);
    await prisma.$disconnect();
  });

  it('survives a new client and refuses the other project', async () => {
    const saved = await store.saveEngineerCase({
      auth: AUTH,
      document: document(),
      requestId: `req-${suffix}`,
      artifacts: [{
        id: `art-${suffix}`.slice(0, 64),
        digest: DIGEST,
        mediaType: 'application/json',
        payload: '{"usable":8}',
        sanitized: true,
        retention: 'case-revision',
      }],
    });
    expect(saved).toMatchObject({ ok: true, status: 'saved', revision: 'rev-1', guideReadyGranted: false });

    const restartedClient = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
    try {
      const restarted = new BlroAuthorityStore(restartedClient);
      const loaded = await restarted.loadEngineerCase({ ...AUTH, caseId });
      expect(loaded).toMatchObject({ ok: true, revision: 'rev-1', evidenceRefs: ['ev-1'] });
      const foreign = await restarted.loadEngineerCase({ ...OTHER, caseId });
      expect(foreign).toMatchObject({ ok: false, status: 'unsaved' });
    } finally {
      await restartedClient.$disconnect();
    }
  });
});
